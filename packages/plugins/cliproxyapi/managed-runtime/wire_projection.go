package managedruntime

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/klauspost/compress/zstd"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/httptransport"
)

const wireProjectionFile = "managed-wire-projection.jsonl"

// Match the pinned Meta and Claude executors' maximum SSE line size. An
// oversized diagnostic frame is skipped without changing delivery to the SDK.
const wireFrameLimit = 52_428_800

var wireIdentifier = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$`)

type wireRequest struct {
	Method     string        `json:"method"`
	Path       string        `json:"path"`
	Model      string        `json:"model,omitempty"`
	Upstream   []*wireStream `json:"upstream"`
	Downstream wireStream    `json:"downstream"`
	responses  bool
	mu         sync.Mutex
}

type wireStream struct {
	Status          int                   `json:"status,omitempty"`
	EventTypes      []string              `json:"eventTypes"`
	StopReason      string                `json:"stopReason,omitempty"`
	Blocks          []wireBlock           `json:"blocks"`
	ArgumentNumbers []wireArgumentNumbers `json:"argumentNumbers,omitempty"`
	Incomplete      bool                  `json:"incomplete,omitempty"`
	positions       map[[2]int]int
}

type wireBlock struct {
	Type       string `json:"type"`
	ID         string `json:"id,omitempty"`
	Name       string `json:"name,omitempty"`
	TextLength *int   `json:"textLength,omitempty"`
}

func managedWireProjection(runtimeDir string) gin.HandlerFunc {
	path := filepath.Join(runtimeDir, wireProjectionFile)
	messages := surfaceRoutes[SurfaceAnthropicMessages][0]
	responses := surfaceRoutes[SurfaceOpenAIResponses][0]
	return func(c *gin.Context) {
		route := Route{Method: c.Request.Method, Path: c.FullPath()}
		if route != messages && route != responses {
			c.Next()
			return
		}
		record := wireRequest{Method: route.Method, Path: route.Path, Upstream: []*wireStream{}, responses: route == responses}
		ctx := httptransport.WithDecorator(c.Request.Context(), record.observeTransport)
		c.Request = c.Request.WithContext(ctx)
		writer := &wireResponseWriter{
			ResponseWriter: c.Writer,
			frames:         wireFrames{stream: &record.Downstream, responses: record.responses},
		}
		func() {
			defer writer.finish()
			c.Writer = writer
			defer func() { c.Writer = writer.ResponseWriter }()
			c.Next()
		}()
		record.Downstream.Status = writer.Status()

		record.mu.Lock()
		line, err := json.Marshal(&record)
		record.mu.Unlock()
		if err != nil {
			return
		}
		if err := appendWireProjection(path, line); err != nil {
			log.Print("managed wire projection could not write its record")
		}
	}
}

func appendWireProjection(path string, line []byte) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(line, '\n'))
	return err
}

type wireTransport func(*http.Request) (*http.Response, error)

func (fn wireTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func (r *wireRequest) observeTransport(next http.RoundTripper) http.RoundTripper {
	return wireTransport(func(request *http.Request) (*http.Response, error) {
		model := wireRequestModel(request)
		response, err := next.RoundTrip(request)
		stream := &wireStream{Incomplete: true}
		if response != nil {
			stream.Status = response.StatusCode
		}
		r.mu.Lock()
		if r.Model == "" {
			r.Model = model
		}
		r.Upstream = append(r.Upstream, stream)
		r.mu.Unlock()
		if response != nil && response.Body != nil {
			response.Body = &wireResponseBody{
				ReadCloser: response.Body,
				mu:         &r.mu,
				frames:     wireFrames{stream: stream, sse: isWireSSE(response.Header), responses: r.responses},
			}
		}
		return response, err
	})
}

func wireRequestModel(request *http.Request) string {
	// The executor constructs replayable JSON bodies. Never consume the
	// transport's actual request body to populate an optional diagnostic field.
	if request.GetBody == nil {
		return ""
	}
	body, err := request.GetBody()
	if err != nil {
		return ""
	}
	defer body.Close()
	var requestShape struct{ Model string }
	if json.NewDecoder(body).Decode(&requestShape) != nil {
		return ""
	}
	return wireLabel(requestShape.Model)
}

func isWireSSE(header http.Header) bool {
	value, _, _ := strings.Cut(header.Get("Content-Type"), ";")
	return strings.EqualFold(strings.TrimSpace(value), "text/event-stream")
}

type wireResponseBody struct {
	io.ReadCloser
	mu       *sync.Mutex
	frames   wireFrames
	finished bool
}

func (body *wireResponseBody) Read(p []byte) (int, error) {
	n, err := body.ReadCloser.Read(p)
	body.mu.Lock()
	defer body.mu.Unlock()
	if !body.finished {
		body.frames.observe(p[:n])
		if err != nil {
			body.finish(err == io.EOF)
		}
	}
	return n, err
}

func (body *wireResponseBody) Close() error {
	err := body.ReadCloser.Close()
	body.mu.Lock()
	defer body.mu.Unlock()
	// Some executors close right after an SSE terminal without reading EOF.
	body.finish(false)
	return err
}

func (body *wireResponseBody) finish(eof bool) {
	if !body.finished {
		body.finished = true
		body.frames.finish()
		body.frames.stream.Incomplete = body.frames.incomplete || !(eof || body.frames.terminal)
	}
}

type wireResponseWriter struct {
	gin.ResponseWriter
	frames  wireFrames
	decoder *io.PipeWriter
	decoded chan struct{}
	started bool
}

func (w *wireResponseWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	w.observe(p[:n])
	return n, err
}

func (w *wireResponseWriter) WriteString(s string) (int, error) {
	return w.Write([]byte(s))
}

func (w *wireResponseWriter) observe(p []byte) {
	if !w.started {
		w.started = true
		w.frames.sse = isWireSSE(w.Header())
		encoding := w.Header().Get("Content-Encoding")
		if encoding != "" && encoding != "identity" {
			// The SDK negotiates compression before this writer sees bytes.
			// Decode a streaming copy and preserve the original transport.
			reader, writer := io.Pipe()
			w.decoder, w.decoded = writer, make(chan struct{})
			go func() {
				defer close(w.decoded)
				defer reader.Close()
				if err := w.decode(reader, encoding); err != nil {
					w.frames.incomplete = true
				}
			}()
		}
	}
	if w.decoder != nil {
		_, _ = w.decoder.Write(p)
	} else {
		w.frames.observe(p)
	}
}

func (w *wireResponseWriter) decode(reader io.Reader, encoding string) error {
	var plain io.ReadCloser
	switch encoding {
	case "gzip":
		decoded, err := gzip.NewReader(reader)
		if err != nil {
			return err
		}
		plain = decoded
	case "zstd":
		decoded, err := zstd.NewReader(reader, zstd.WithDecoderConcurrency(1))
		if err != nil {
			return err
		}
		plain = decoded.IOReadCloser()
	default:
		return io.ErrUnexpectedEOF
	}
	defer plain.Close()
	_, err := io.Copy(wireFrameWriter{&w.frames}, plain)
	return err
}

func (w *wireResponseWriter) finish() {
	if w.decoder != nil {
		_ = w.decoder.Close()
		<-w.decoded
	}
	w.frames.finish()
	if w.frames.sse && !w.frames.terminal {
		w.frames.stream.Incomplete = true
	}
}

type wireFrameWriter struct{ frames *wireFrames }

func (w wireFrameWriter) Write(p []byte) (int, error) {
	w.frames.observe(p)
	return len(p), nil
}

type wireFrames struct {
	stream         *wireStream
	pending        []byte
	sse            bool
	skipping       bool
	terminal       bool
	incomplete     bool
	responses      bool
	argumentDeltas map[int][]byte
}

func (f *wireFrames) observe(p []byte) {
	for len(p) > 0 {
		part, rest, newline := p, []byte(nil), false
		if f.sse {
			part, rest, newline = bytes.Cut(p, []byte{'\n'})
		}
		if !f.skipping {
			if len(part) > wireFrameLimit-len(f.pending) {
				f.incomplete = true
				f.skipping = true
				f.pending = nil
			} else {
				f.pending = append(f.pending, part...)
			}
		}
		if newline {
			f.flush()
		}
		p = rest
	}
}

func (f *wireFrames) flush() {
	data := f.pending
	f.pending = nil
	f.skipping = false
	if f.sse {
		var ok bool
		data, ok = bytes.CutPrefix(data, []byte("data:"))
		if !ok {
			return
		}
	}
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return
	}
	if bytes.Equal(data, []byte("[DONE]")) {
		f.stream.EventTypes = append(f.stream.EventTypes, "done")
		f.terminal = true
		return
	}
	var frame wireFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		f.incomplete = true
		return
	}
	f.project(frame)
}

func (f *wireFrames) finish() {
	f.flush()
	f.finishArgumentDeltas()
	f.stream.Incomplete = f.incomplete
	if f.stream.EventTypes == nil {
		f.stream.EventTypes = []string{}
	}
	if f.stream.Blocks == nil {
		f.stream.Blocks = []wireBlock{}
	}
}

// Deliberately decode only protocol structure and fields needed to measure
// text. Unmapped types and stop reasons never reach the output as raw strings.
type wirePart struct {
	Type, ID, Name, Text string
	CallID               string `json:"call_id"`
	Content              []wirePart
	Output               []wirePart
	StopReason           string `json:"stop_reason"`
	Arguments            json.RawMessage
}

type wireFrame struct {
	wirePart
	Index        int
	OutputIndex  int `json:"output_index"`
	ContentIndex int `json:"content_index"`
	Message      wirePart
	ContentBlock wirePart `json:"content_block"`
	Delta        json.RawMessage
	Item         wirePart
	Part         wirePart
	Response     wirePart
}

func (f *wireFrames) project(frame wireFrame) {
	s := f.stream
	switch frame.Type {
	case "message_start", "message_delta", "message_stop", "content_block_start", "content_block_delta", "content_block_stop",
		"ping", "error", "response.created", "response.in_progress", "response.completed", "response.incomplete",
		"response.failed", "response.output_item.added", "response.output_item.done", "response.content_part.added",
		"response.content_part.done", "response.output_text.delta", "response.output_text.done",
		"response.function_call_arguments.delta", "response.function_call_arguments.done",
		"response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
		"response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
		"response.refusal.delta", "response.refusal.done":
		s.EventTypes = append(s.EventTypes, frame.Type)
	default:
		if f.sse {
			s.EventTypes = append(s.EventTypes, "unknown")
		}
	}
	switch frame.Type {
	case "message_stop", "response.completed", "response.incomplete", "response.failed":
		f.terminal = true
	}
	if f.responses {
		f.projectResponseArguments(frame)
		return
	}
	switch frame.Type {
	case "message":
		s.parts(0, frame.Content)
		s.stop(frame.StopReason)
	case "message_start":
		s.parts(0, frame.Message.Content)
		s.stop(frame.Message.StopReason)
	case "message_delta", "content_block_delta":
		var delta wirePart
		if json.Unmarshal(frame.Delta, &delta) == nil {
			s.stop(delta.StopReason)
			if delta.Type == "text_delta" {
				delta.Type = "text"
				s.block([2]int{0, frame.Index}, delta, true)
			}
		}
	case "content_block_start":
		s.block([2]int{0, frame.Index}, frame.ContentBlock, false)
	case "response.output_item.added", "response.output_item.done":
		s.output(frame.OutputIndex, frame.Item)
	case "response.content_part.added", "response.content_part.done":
		s.block([2]int{frame.OutputIndex, frame.ContentIndex}, frame.Part, false)
	case "response.output_text.delta":
		var delta string
		if json.Unmarshal(frame.Delta, &delta) == nil {
			s.block([2]int{frame.OutputIndex, frame.ContentIndex}, wirePart{Type: "output_text", Text: delta}, true)
		}
	case "response.output_text.done":
		s.block([2]int{frame.OutputIndex, frame.ContentIndex}, wirePart{Type: "output_text", Text: frame.Text}, false)
	case "response.completed", "response.incomplete", "response.failed":
		for index, item := range frame.Response.Output {
			s.output(index, item)
		}
		s.stop(frame.Response.StopReason)
	case "response":
		for index, item := range frame.Output {
			s.output(index, item)
		}
	}
}

func (s *wireStream) stop(reason string) {
	switch reason {
	case "end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal":
		s.StopReason = reason
	}
}

func (s *wireStream) output(index int, item wirePart) {
	if item.Type == "message" {
		s.parts(index, item.Content)
		return
	}
	s.block([2]int{index, 0}, item, false)
}

func (s *wireStream) parts(output int, content []wirePart) {
	for index, part := range content {
		s.block([2]int{output, index}, part, false)
	}
}

func (s *wireStream) block(position [2]int, part wirePart, delta bool) {
	block := wireBlock{Type: part.Type}
	switch part.Type {
	case "text", "output_text":
		size := len(part.Text)
		block.TextLength = &size
	case "tool_use":
		block.ID, block.Name = wireLabel(part.ID), wireLabel(part.Name)
	case "function_call":
		block.ID, block.Name = wireLabel(part.CallID), wireLabel(part.Name)
	case "tool_result", "thinking", "redacted_thinking", "reasoning", "refusal", "server_tool_use", "web_search_tool_result":
	default:
		block.Type = "unknown"
	}
	if s.positions == nil {
		s.positions = make(map[[2]int]int)
	}
	if index, ok := s.positions[position]; ok {
		if delta && s.Blocks[index].TextLength != nil {
			*block.TextLength += *s.Blocks[index].TextLength
		}
		s.Blocks[index] = block
		return
	}
	s.positions[position] = len(s.Blocks)
	s.Blocks = append(s.Blocks, block)
}

func wireLabel(value string) string {
	if wireIdentifier.MatchString(value) {
		return value
	}
	return ""
}
