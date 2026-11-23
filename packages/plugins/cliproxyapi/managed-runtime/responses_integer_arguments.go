package managedruntime

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
)

type integerFields map[string]bool
type integerToolSchemas map[string]integerFields

func responseIntegerSchemas(request *http.Request) integerToolSchemas {
	if request.GetBody == nil {
		return nil
	}
	body, err := request.GetBody()
	if err != nil {
		return nil
	}
	defer body.Close()
	var payload struct {
		Tools []struct {
			Type, Name string
			Parameters struct {
				Properties map[string]struct{ Type json.RawMessage }
			}
		}
	}
	if json.NewDecoder(body).Decode(&payload) != nil {
		return nil
	}
	schemas := make(integerToolSchemas)
	for _, tool := range payload.Tools {
		if tool.Type != "function" || tool.Name == "" {
			continue
		}
		if _, duplicate := schemas[tool.Name]; duplicate {
			schemas[tool.Name] = nil
			continue
		}
		fields := make(integerFields)
		for name, parameter := range tool.Parameters.Properties {
			if string(parameter.Type) == `"integer"` {
				fields[name] = true
			}
		}
		schemas[tool.Name] = fields
	}
	for _, fields := range schemas {
		if len(fields) != 0 {
			return schemas
		}
	}
	return nil
}

func normalizeMuseResponseIntegers(next http.RoundTripper) http.RoundTripper {
	return wireTransport(func(request *http.Request) (*http.Response, error) {
		response, err := next.RoundTrip(request)
		if err != nil || response == nil || response.Body == nil || response.StatusCode != http.StatusOK ||
			!isWireSSE(response.Header) || requireAllowedHTTPSOrigin(request.URL, managedFamilies[ProviderMeta].Origins) != nil {
			return response, err
		}
		// The pinned Muse executor uses SSE upstream for both streaming and
		// non-streaming Responses. GetBody exposes the schema after SDK shaping.
		if schemas := responseIntegerSchemas(request); schemas != nil {
			response.Body = &integerArgumentStream{
				ReadCloser: response.Body,
				source:     bufio.NewReader(response.Body),
				schemas:    schemas,
				calls:      make(map[int]*streamedIntegerArguments),
			}
			response.ContentLength = -1
			response.Header.Del("Content-Length")
		}
		return response, nil
	})
}

// Keep the original JSON spelling and whitespace outside the edited number
// tokens. Decode only top-level values because these are the schema fields we
// can resolve directly. In particular, never convert via binary floating point.
func normalizeIntegerArguments(arguments string, fields integerFields) string {
	if len(fields) == 0 {
		return arguments
	}
	return rewriteJSONChildren(arguments, '{', func(key, raw string) string {
		if !fields[key] {
			return raw
		}
		return exactIntegerSpelling(raw)
	})
}

func exactIntegerSpelling(raw string) string {
	// Native Codex's integer arguments fit into signed or unsigned 64-bit
	// values. This also prevents short exponent tokens from amplifying frames.
	const maxNativeIntegerDigits = 20
	unsigned, negative := strings.CutPrefix(raw, "-")
	if unsigned == "" || unsigned[0] < '0' || unsigned[0] > '9' {
		return raw
	}
	end := strings.IndexAny(unsigned, "eE")
	significand, exponent := unsigned, 0
	if end >= 0 {
		significand = unsigned[:end]
		var err error
		exponent, err = strconv.Atoi(unsigned[end+1:])
		if err != nil || exponent > len(significand)+maxNativeIntegerDigits || exponent < -len(significand) {
			return raw
		}
	}
	whole, fraction, decimal := strings.Cut(significand, ".")
	if !decimal && end < 0 {
		return raw
	}
	digits := strings.TrimLeft(whole+fraction, "0")
	if digits == "" {
		return "0"
	}
	shift := exponent - len(fraction)
	if shift < 0 {
		cut := len(digits) + shift
		if cut <= 0 || strings.Trim(digits[cut:], "0") != "" {
			return raw
		}
		digits = digits[:cut]
		shift = 0
	}
	sign := ""
	if negative {
		sign = "-"
	}
	if len(digits)+shift > maxNativeIntegerDigits {
		return raw
	}
	spelling := sign + digits + strings.Repeat("0", shift)
	if negative {
		if _, err := strconv.ParseInt(spelling, 10, 64); err != nil {
			return raw
		}
	} else if _, err := strconv.ParseUint(spelling, 10, 64); err != nil {
		return raw
	}
	return spelling
}

// Patch only the affected raw values. A map re-encode would also change
// unrelated fields' order, whitespace, and escape spelling.
func rewriteJSONChildren(raw string, container json.Delim, edit func(key, value string) string) string {
	decoder := json.NewDecoder(strings.NewReader(raw))
	if token, _ := decoder.Token(); token != container {
		return raw
	}
	var output strings.Builder
	copied := 0
	for decoder.More() {
		var key string
		if container == '{' {
			token, err := decoder.Token()
			if err != nil {
				return raw
			}
			key = token.(string)
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return raw
		}
		original := string(value)
		if changed := edit(key, original); changed != original {
			end := int(decoder.InputOffset())
			output.WriteString(raw[copied : end-len(original)])
			output.WriteString(changed)
			copied = end
		}
	}
	if _, err := decoder.Token(); err != nil {
		return raw
	}
	if copied == 0 || strings.Trim(raw[decoder.InputOffset():], " \t\r\n") != "" {
		return raw
	}
	output.WriteString(raw[copied:])
	return output.String()
}

type streamedIntegerArguments struct {
	fields integerFields
	deltas []integerArgumentDelta
}

type integerArgumentDelta struct {
	line  int
	value string
}

// Hold only the part of the stream between a candidate argument's first
// fragment and its completion. Keeping intervening lines in the same queue
// preserves SSE order and event metadata even when tool calls interleave.
type integerArgumentStream struct {
	io.ReadCloser
	source  *bufio.Reader
	schemas integerToolSchemas
	calls   map[int]*streamedIntegerArguments
	pending int
	queued  []string
	size    int
	output  string
	readErr error
}

func (s *integerArgumentStream) Read(p []byte) (int, error) {
	for s.output == "" && s.readErr == nil {
		line, err := s.source.ReadString('\n')
		if s.size+len(line) > wireFrameLimit {
			// Reuse the SDK's frame size as the maximum queued burst. Flush and
			// pass through if a fragmented burst exceeds what the codec can hold.
			s.pending = 0
			s.schemas = nil
			s.calls = nil
		}
		s.queued = append(s.queued, line)
		s.size += len(line)
		if s.schemas != nil {
			s.rewrite(len(s.queued) - 1)
		}
		s.readErr = err
		if s.pending == 0 || err != nil {
			s.output = strings.Join(s.queued, "")
			clear(s.queued)
			s.queued = s.queued[:0]
			s.size = 0
		}
	}
	if s.output == "" {
		return 0, s.readErr
	}
	n := copy(p, s.output)
	s.output = s.output[n:]
	return n, nil
}

func editIntegerEvent(line string, edit func(body string, event wireObject) string) string {
	data := strings.TrimLeft(line, " \t")
	payload, ok := strings.CutPrefix(data, "data:")
	if !ok {
		return line
	}
	var event wireObject
	if json.Unmarshal([]byte(payload), &event) != nil {
		return line
	}
	return line[:len(line)-len(payload)] + edit(payload, event)
}

func (s *integerArgumentStream) rewrite(lineIndex int) {
	s.queued[lineIndex] = editIntegerEvent(s.queued[lineIndex], func(body string, event wireObject) string {
		var index int
		_ = json.Unmarshal(event["output_index"], &index)
		call := s.calls[index]
		switch textField(event, "type") {
		case "response.output_item.added", "response.output_item.done":
			if textField(event, "type") == "response.output_item.done" {
				s.finish(call)
				delete(s.calls, index)
			}
			return editJSONField(body, "item", func(item string) string {
				fields := s.callFields(item)
				if len(fields) > 0 && textField(event, "type") == "response.output_item.added" && call == nil {
					s.calls[index] = &streamedIntegerArguments{fields: fields}
				}
				return rewriteIntegerArgumentField(item, fields)
			})
		case "response.function_call_arguments.delta":
			if call != nil {
				if len(call.deltas) == 0 {
					s.pending++
				}
				call.deltas = append(call.deltas, integerArgumentDelta{lineIndex, textField(event, "delta")})
			}
		case "response.function_call_arguments.done":
			fields := s.schemas[textField(event, "name")]
			if call != nil {
				s.finish(call)
				fields = call.fields
			}
			return rewriteIntegerArgumentField(body, fields)
		case "response.completed", "response.incomplete", "response.failed":
			for _, active := range s.calls {
				s.finish(active)
			}
			clear(s.calls)
			return editJSONField(body, "response", func(response string) string {
				return editJSONField(response, "output", func(output string) string {
					return rewriteJSONChildren(output, '[', func(_, item string) string {
						return rewriteIntegerArgumentField(item, s.callFields(item))
					})
				})
			})
		}
		return body
	})
}

func (s *integerArgumentStream) callFields(raw string) integerFields {
	var item wireObject
	if json.Unmarshal([]byte(raw), &item) == nil && textField(item, "type") == "function_call" {
		return s.schemas[textField(item, "name")]
	}
	return nil
}

func editJSONField(body, field string, edit func(string) string) string {
	return rewriteJSONChildren(body, '{', func(key, raw string) string {
		if key == field {
			return edit(raw)
		}
		return raw
	})
}

func (s *integerArgumentStream) finish(call *streamedIntegerArguments) {
	if call == nil || len(call.deltas) == 0 {
		return
	}
	var original strings.Builder
	for _, delta := range call.deltas {
		original.WriteString(delta.value)
	}
	normalized := normalizeIntegerArguments(original.String(), call.fields)
	if normalized != original.String() {
		for i, delta := range call.deltas {
			// Preserve the original split size when possible and never split a
			// UTF-8 sequence at a new boundary created by removing decimal bytes.
			end := len(normalized)
			if i < len(call.deltas)-1 {
				end = min(len(delta.value), end)
			}
			for end < len(normalized) && normalized[end]&0xc0 == 0x80 {
				end++
			}
			value := normalized[:end]
			normalized = normalized[end:]
			if value != delta.value {
				s.queued[delta.line] = editIntegerEvent(s.queued[delta.line], func(body string, _ wireObject) string {
					return editJSONField(body, "delta", func(string) string { return string(encodeWire(value)) })
				})
			}
		}
	}
	call.deltas = nil
	s.pending--
}

func rewriteIntegerArgumentField(body string, fields integerFields) string {
	if len(fields) == 0 {
		return body
	}
	return editJSONField(body, "arguments", func(raw string) string {
		var arguments string
		if json.Unmarshal([]byte(raw), &arguments) == nil {
			if normalized := normalizeIntegerArguments(arguments, fields); normalized != arguments {
				return string(encodeWire(normalized))
			}
		}
		return raw
	})
}
