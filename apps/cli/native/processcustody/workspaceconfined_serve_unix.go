//go:build linux || darwin

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"golang.org/x/sys/unix"
)

type servePendingOp struct {
	op               workspaceConfinedPreparedOperation
	stagingDirectory string
	stageOnTarget    bool
}

func (p *servePendingOp) cleanup(preserveRecovery bool) {
	if p.op != nil {
		p.op.close()
		p.op = nil
	}
	if p.stagingDirectory != "" && !preserveRecovery {
		_ = os.RemoveAll(p.stagingDirectory)
		p.stagingDirectory = ""
	}
}

type serveExclusiveOp struct {
	parent *workspaceConfinedUnixPath
	name   string
	file   *os.File
}

func (e *serveExclusiveOp) close() {
	if e.file != nil {
		_ = e.file.Close()
		e.file = nil
	}
	if e.parent != nil {
		e.parent.close()
		e.parent = nil
	}
}

var errStreamBufferExceeded = errors.New("apply stream buffer exceeded limit")

func tryReserveStreamBytes(counter *atomic.Int64, limit int64, n int64) bool {
	for {
		cur := counter.Load()
		if cur+n > limit {
			return false
		}
		if counter.CompareAndSwap(cur, cur+n) {
			return true
		}
	}
}

type serveChunkPipe struct {
	mu            sync.Mutex
	cond          *sync.Cond
	chunks        [][]byte
	queuedBytes   int64
	maxPipeBytes  int64
	totalQueued   *atomic.Int64
	maxTotalBytes int64
	eof           bool
	finished      bool
	abortErr      error
	pending       []byte
}

func newServeChunkPipe(maxPipeBytes int64, totalQueued *atomic.Int64, maxTotalBytes int64) *serveChunkPipe {
	p := &serveChunkPipe{
		maxPipeBytes:  maxPipeBytes,
		totalQueued:   totalQueued,
		maxTotalBytes: maxTotalBytes,
	}
	p.cond = sync.NewCond(&p.mu)
	return p
}

func (p *serveChunkPipe) releaseQueuedLocked() {
	if p.queuedBytes > 0 {
		if p.totalQueued != nil {
			p.totalQueued.Add(-p.queuedBytes)
		}
		p.queuedBytes = 0
	}
	p.chunks = nil
}

// push enqueues a chunk without blocking the main stdin control loop so cancel/abort/commit
// frames are always processed immediately even under full worker concurrency. If the per-pipe
// or aggregate high-water cap would be exceeded, it fails closed on this stream only and drops
// subsequent chunks without blocking.
func (p *serveChunkPipe) push(data []byte) {
	if len(data) == 0 {
		return
	}
	p.mu.Lock()
	if p.eof || p.finished || p.abortErr != nil {
		p.mu.Unlock()
		return
	}
	n := int64(len(data))
	if (p.maxPipeBytes > 0 && p.queuedBytes+n > p.maxPipeBytes) ||
		(p.totalQueued != nil && p.maxTotalBytes > 0 && !tryReserveStreamBytes(p.totalQueued, p.maxTotalBytes, n)) {
		p.abortErr = errStreamBufferExceeded
		p.eof = true
		p.finished = true
		p.releaseQueuedLocked()
		p.cond.Broadcast()
		p.mu.Unlock()
		return
	}
	p.queuedBytes += n
	p.chunks = append(p.chunks, data)
	p.cond.Signal()
	p.mu.Unlock()
}

func (p *serveChunkPipe) closeEOF() {
	p.mu.Lock()
	p.eof = true
	p.cond.Broadcast()
	p.mu.Unlock()
}

func (p *serveChunkPipe) abort(err error) {
	p.mu.Lock()
	if p.abortErr == nil {
		p.abortErr = err
	}
	p.eof = true
	p.finished = true
	p.releaseQueuedLocked()
	p.cond.Broadcast()
	p.mu.Unlock()
}

func (p *serveChunkPipe) finishReader() {
	p.mu.Lock()
	p.finished = true
	p.releaseQueuedLocked()
	p.cond.Broadcast()
	p.mu.Unlock()
}

func (p *serveChunkPipe) Read(dst []byte) (int, error) {
	if len(p.pending) == 0 {
		p.mu.Lock()
		for len(p.chunks) == 0 && !p.eof && p.abortErr == nil {
			p.cond.Wait()
		}
		if p.abortErr != nil {
			err := p.abortErr
			p.mu.Unlock()
			return 0, err
		}
		if len(p.chunks) == 0 {
			p.mu.Unlock()
			return 0, io.EOF
		}
		chunk := p.chunks[0]
		p.chunks[0] = nil
		p.chunks = p.chunks[1:]
		if len(p.chunks) == 0 {
			p.chunks = nil
		}
		n := int64(len(chunk))
		p.queuedBytes -= n
		if p.totalQueued != nil {
			p.totalQueued.Add(-n)
		}
		p.mu.Unlock()
		p.pending = chunk
	}
	n := copy(dst, p.pending)
	p.pending = p.pending[n:]
	return n, nil
}

type serveServerOptions struct {
	maxStreamPipeBytes      int64
	maxTotalStreamPipeBytes int64
}

type workspaceConfinedServer struct {
	pinnedRoot workspaceConfinedUnixHandle
	rootPath   string
	output     io.Writer
	outMu      sync.Mutex

	maxStreamPipeBytes      int64
	maxTotalStreamPipeBytes int64
	totalStreamQueued       atomic.Int64

	mu           sync.Mutex
	inflight     map[string]context.CancelFunc
	pending      map[string]*servePendingOp
	exclusive    map[string]*serveExclusiveOp
	applyStreams map[string]*serveChunkPipe

	sem chan struct{}
	wg  sync.WaitGroup
}

func runWorkspaceConfinedServe(rootPath string, input io.Reader, output io.Writer) error {
	return runWorkspaceConfinedServeWithOptions(rootPath, input, output, serveServerOptions{
		maxStreamPipeBytes:      serveMaxStreamPipeBytes,
		maxTotalStreamPipeBytes: serveMaxTotalStreamPipeBytes,
	})
}

func runWorkspaceConfinedServeWithOptions(rootPath string, input io.Reader, output io.Writer, opts serveServerOptions) error {
	if opts.maxStreamPipeBytes <= 0 {
		opts.maxStreamPipeBytes = serveMaxStreamPipeBytes
	}
	if opts.maxTotalStreamPipeBytes <= 0 {
		opts.maxTotalStreamPipeBytes = serveMaxTotalStreamPipeBytes
	}
	cleanRoot := filepath.Clean(rootPath)
	pinnedRoot, err := openWorkspaceConfinedUnixRoot(cleanRoot)
	if err != nil {
		_ = writeWorkspaceConfinedRecord(output, serveResponseFrame{
			V:       1,
			T:       "workspace-confined-serve-error",
			Code:    "workspace_root_unsafe",
			Message: "workspace root could not be opened safely",
		})
		return fmt.Errorf("workspace-confined-serve: %w", err)
	}
	defer unix.Close(pinnedRoot.fd)

	server := &workspaceConfinedServer{
		pinnedRoot:              pinnedRoot,
		rootPath:                cleanRoot,
		output:                  output,
		maxStreamPipeBytes:      opts.maxStreamPipeBytes,
		maxTotalStreamPipeBytes: opts.maxTotalStreamPipeBytes,
		inflight:                make(map[string]context.CancelFunc),
		pending:                 make(map[string]*servePendingOp),
		exclusive:               make(map[string]*serveExclusiveOp),
		applyStreams:            make(map[string]*serveChunkPipe),
		sem:                     make(chan struct{}, serveMaxConcurrency),
	}

	if err := server.writeFrame(serveResponseFrame{V: 1, T: "workspace-confined-serve-ready"}, nil); err != nil {
		return err
	}

	rootCtx, rootCancel := context.WithCancel(context.Background())
	defer func() {
		rootCancel()
		server.abortAllStreams()
		server.wg.Wait()
		server.cleanupAllParked()
	}()

	reader := bufio.NewReaderSize(input, 64*1024)
	for {
		line, err := readServeHeaderLine(reader)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read serve request: %w", err)
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var header serveFrameHeader
		if err := json.Unmarshal(line, &header); err != nil {
			return fmt.Errorf("decode serve request: %w", err)
		}
		if header.BodyBytes < 0 || header.BodyBytes > serveMaxBodyBytes {
			return fmt.Errorf("serve bodyBytes out of bounds: %d", header.BodyBytes)
		}
		var body []byte
		if header.BodyBytes > 0 {
			body = make([]byte, header.BodyBytes)
			if _, err := io.ReadFull(reader, body); err != nil {
				return fmt.Errorf("read serve request body: %w", err)
			}
		}
		if header.V != 1 || header.ID == "" {
			if header.ID != "" {
				_ = server.writeFrame(serveResponseFrame{
					V:      1,
					ID:     header.ID,
					T:      "result",
					Result: workspaceTargetError("workspace_root_unsafe", "invalid serve request envelope"),
				}, nil)
			}
			continue
		}

		// Control frames are handled directly without waiting on the concurrency semaphore.
		switch header.Op {
		case "cancel":
			server.handleCancel(header.ID)
			continue
		case "abort":
			server.handleAbort(header.ID)
			continue
		case "commit":
			server.handleCommit(rootCtx, header.ID)
			continue
		case "open-exclusive-finish":
			server.handleOpenExclusiveFinish(rootCtx, header)
			continue
		case "apply-chunk":
			server.handleApplyChunk(header.ID, body)
			continue
		case "apply-eof":
			server.handleApplyEOF(header.ID)
			continue
		}

		reqCtx, reqCancel := context.WithCancel(rootCtx)
		var applyPipe *serveChunkPipe
		server.mu.Lock()
		_, inInflight := server.inflight[header.ID]
		_, inPending := server.pending[header.ID]
		_, inExclusive := server.exclusive[header.ID]
		_, inApply := server.applyStreams[header.ID]
		if inInflight || inPending || inExclusive || inApply {
			server.mu.Unlock()
			reqCancel()
			_ = server.writeFrame(serveResponseFrame{
				V:      1,
				ID:     header.ID,
				T:      "result",
				Result: workspaceTargetError("workspace_root_unsafe", "duplicate request id"),
			}, nil)
			continue
		}
		server.inflight[header.ID] = reqCancel
		if header.Op == "apply" && header.StreamMaterial {
			applyPipe = newServeChunkPipe(server.maxStreamPipeBytes, &server.totalStreamQueued, server.maxTotalStreamPipeBytes)
			server.applyStreams[header.ID] = applyPipe
		}
		server.mu.Unlock()

		server.wg.Add(1)
		go func(h serveFrameHeader, b []byte, ctx context.Context, cancel context.CancelFunc, pipe *serveChunkPipe) {
			defer server.wg.Done()
			defer cancel()
			defer func() {
				if pipe != nil {
					pipe.finishReader()
					server.removeApplyStream(h.ID, pipe)
				}
			}()
			select {
			case server.sem <- struct{}{}:
			case <-ctx.Done():
				server.clearInflight(h.ID)
				_ = server.writeFrame(serveResponseFrame{V: 1, ID: h.ID, T: "cancelled"}, nil)
				return
			}
			defer func() { <-server.sem }()
			server.executeRequest(ctx, h, b, pipe)
		}(header, body, reqCtx, reqCancel, applyPipe)
	}
}

func (s *workspaceConfinedServer) writeFrame(frame serveResponseFrame, body []byte) error {
	if len(body) > 0 {
		frame.BodyBytes = int64(len(body))
	}
	encoded, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	s.outMu.Lock()
	defer s.outMu.Unlock()
	if _, err := s.output.Write(encoded); err != nil {
		return err
	}
	if len(body) > 0 {
		if _, err := s.output.Write(body); err != nil {
			return err
		}
	}
	return nil
}

func (s *workspaceConfinedServer) clearInflight(id string) {
	s.mu.Lock()
	delete(s.inflight, id)
	s.mu.Unlock()
}

func (s *workspaceConfinedServer) removeApplyStream(id string, pipe *serveChunkPipe) {
	s.mu.Lock()
	if s.applyStreams[id] == pipe {
		delete(s.applyStreams, id)
	}
	s.mu.Unlock()
}

func (s *workspaceConfinedServer) abortAllStreams() {
	s.mu.Lock()
	streams := make([]*serveChunkPipe, 0, len(s.applyStreams))
	for _, pipe := range s.applyStreams {
		streams = append(streams, pipe)
	}
	s.mu.Unlock()
	for _, pipe := range streams {
		pipe.abort(context.Canceled)
	}
}

func (s *workspaceConfinedServer) cleanupAllParked() {
	s.mu.Lock()
	pending := s.pending
	s.pending = make(map[string]*servePendingOp)
	exclusive := s.exclusive
	s.exclusive = make(map[string]*serveExclusiveOp)
	s.mu.Unlock()
	for _, op := range pending {
		op.cleanup(false)
	}
	for _, ex := range exclusive {
		ex.close()
	}
}

func (s *workspaceConfinedServer) handleApplyChunk(id string, body []byte) {
	s.mu.Lock()
	pipe := s.applyStreams[id]
	s.mu.Unlock()
	if pipe != nil {
		pipe.push(body)
	}
}

func (s *workspaceConfinedServer) handleApplyEOF(id string) {
	s.mu.Lock()
	pipe := s.applyStreams[id]
	s.mu.Unlock()
	if pipe != nil {
		pipe.closeEOF()
	}
}

func (s *workspaceConfinedServer) handleCancel(id string) {
	s.mu.Lock()
	cancel, active := s.inflight[id]
	pipe := s.applyStreams[id]
	var pendingOp *servePendingOp
	var exclusiveOp *serveExclusiveOp
	if !active {
		if p, ok := s.pending[id]; ok {
			delete(s.pending, id)
			pendingOp = p
		}
		if e, ok := s.exclusive[id]; ok {
			delete(s.exclusive, id)
			exclusiveOp = e
		}
	}
	s.mu.Unlock()

	if pipe != nil {
		pipe.abort(context.Canceled)
	}
	if active {
		cancel()
		return
	}
	if pendingOp != nil {
		pendingOp.cleanup(false)
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: id, T: "cancelled"}, nil)
		return
	}
	if exclusiveOp != nil {
		exclusiveOp.close()
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: id, T: "cancelled"}, nil)
	}
}

func (s *workspaceConfinedServer) handleAbort(id string) {
	s.mu.Lock()
	cancel, active := s.inflight[id]
	pipe := s.applyStreams[id]
	pendingOp, hadPending := s.pending[id]
	if hadPending {
		delete(s.pending, id)
	}
	exclusiveOp, hadExclusive := s.exclusive[id]
	if hadExclusive {
		delete(s.exclusive, id)
	}
	s.mu.Unlock()

	if pipe != nil {
		pipe.abort(context.Canceled)
	}
	if hadPending {
		pendingOp.cleanup(false)
	}
	if hadExclusive {
		exclusiveOp.close()
	}
	if active {
		// Cancel the active prepare goroutine; it observes ctx.Err() != nil,
		// cleans up any staging/prepared state without parking in s.pending,
		// and writes the single terminal "cancelled" frame.
		cancel()
		return
	}
	_ = s.writeFrame(serveResponseFrame{V: 1, ID: id, T: "aborted"}, nil)
}

func (s *workspaceConfinedServer) handleCommit(rootCtx context.Context, id string) {
	s.mu.Lock()
	pendingOp, ok := s.pending[id]
	if !ok {
		s.mu.Unlock()
		_ = s.writeFrame(serveResponseFrame{
			V:      1,
			ID:     id,
			T:      "result",
			Result: workspaceConfinedError("workspace_root_unsafe", "no prepared workspace operation for commit").result(),
		}, nil)
		return
	}
	delete(s.pending, id)
	reqCtx, reqCancel := context.WithCancel(rootCtx)
	s.inflight[id] = reqCancel
	s.mu.Unlock()

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer reqCancel()
		defer s.clearInflight(id)

		select {
		case s.sem <- struct{}{}:
		case <-reqCtx.Done():
			pendingOp.cleanup(false)
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: id, T: "cancelled"}, nil)
			return
		}
		defer func() { <-s.sem }()

		if reqCtx.Err() != nil {
			pendingOp.cleanup(false)
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: id, T: "cancelled"}, nil)
			return
		}
		result := pendingOp.op.commit()
		preserveRecovery := pendingOp.stageOnTarget && result.Status == "recovery_needed"
		pendingOp.cleanup(preserveRecovery)
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: id, T: "result", Result: result}, nil)
	}()
}

func (s *workspaceConfinedServer) handleOpenExclusiveFinish(rootCtx context.Context, header serveFrameHeader) {
	s.mu.Lock()
	ex, ok := s.exclusive[header.ID]
	if !ok {
		s.mu.Unlock()
		_ = s.writeFrame(serveResponseFrame{
			V:      1,
			ID:     header.ID,
			T:      "result",
			Result: workspaceTargetError("io_failed", "no open exclusive file for request"),
		}, nil)
		return
	}
	delete(s.exclusive, header.ID)
	reqCtx, reqCancel := context.WithCancel(rootCtx)
	s.inflight[header.ID] = reqCancel
	s.mu.Unlock()

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer reqCancel()
		defer s.clearInflight(header.ID)
		defer ex.close()

		select {
		case s.sem <- struct{}{}:
		case <-reqCtx.Done():
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "cancelled"}, nil)
			return
		}
		defer func() { <-s.sem }()

		if header.RelativePath == "" {
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetStatus("done")}, nil)
			return
		}
		source, domainErr := openWorkspaceTargetPathWithRoot(&s.pinnedRoot, s.rootPath, header.RelativePath, false)
		if domainErr != nil {
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetDomainResult(domainErr)}, nil)
			return
		}
		defer source.close()
		if source.isMissing() || source.final().kind != workspaceConfinedKindFile {
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetError("workspace_file_unsupported", "source is not a regular file")}, nil)
			return
		}
		if header.Mode != nil {
			if *header.Mode > 0o777 {
				_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetError("workspace_root_unsafe", "invalid exclusive file mode")}, nil)
				return
			}
			if err := ex.file.Chmod(os.FileMode(*header.Mode)); err != nil {
				_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetError("io_failed", "exclusive file mode could not be set")}, nil)
				return
			}
		}
		if err := copyWorkspaceTargetFile(ex.file, source.final()); err != nil {
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetError("io_failed", "exclusive file could not be written")}, nil)
			return
		}
		if err := ex.file.Sync(); err != nil {
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetError("io_failed", "exclusive file could not be flushed")}, nil)
			return
		}
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetStatus("done")}, nil)
	}()
}

func (s *workspaceConfinedServer) executeRequest(ctx context.Context, header serveFrameHeader, body []byte, applyPipe *serveChunkPipe) {
	if ctx.Err() != nil {
		s.clearInflight(header.ID)
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "cancelled"}, nil)
		return
	}

	switch header.Op {
	case "stat", "lstat", "readdir", "list", "readlink", "realpath", "access-executable", "capture-leaf":
		defer s.clearInflight(header.ID)
		metaOp := header.Op
		if metaOp == "readdir" {
			metaOp = "list"
		}
		result := runWorkspaceTargetMetaWithRoot(&s.pinnedRoot, workspaceTargetMetaRequest{
			rootPath:     s.rootPath,
			relativePath: header.RelativePath,
			op:           metaOp,
		})
		if ctx.Err() != nil {
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "cancelled"}, nil)
			return
		}
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: result}, nil)

	case "statBatch":
		defer s.clearInflight(header.ID)
		metaOp := "stat"
		if header.FollowSymlinks != nil && !*header.FollowSymlinks {
			metaOp = "lstat"
		}
		results := make([]workspaceTargetResult, 0, len(header.Paths))
		for _, relPath := range header.Paths {
			if ctx.Err() != nil {
				_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "cancelled"}, nil)
				return
			}
			results = append(results, runWorkspaceTargetMetaWithRoot(&s.pinnedRoot, workspaceTargetMetaRequest{
				rootPath:     s.rootPath,
				relativePath: relPath,
				op:           metaOp,
			}))
		}
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Results: results}, nil)

	case "captureBatch":
		defer s.clearInflight(header.ID)
		budget := workspaceTargetCaptureLeafMaxBytes
		if header.MaxTotalInlineBytes != nil && *header.MaxTotalInlineBytes < budget {
			budget = *header.MaxTotalInlineBytes
		}
		results := make([]workspaceTargetResult, 0, len(header.Paths))
		for _, relPath := range header.Paths {
			if ctx.Err() != nil {
				_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "cancelled"}, nil)
				return
			}
			item, consumed := captureWorkspaceTargetLeafWithRoot(&s.pinnedRoot, s.rootPath, relPath, budget)
			if consumed >= budget {
				budget = 0
			} else {
				budget -= consumed
			}
			results = append(results, item)
		}
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Results: results}, nil)

	case "readFile":
		defer s.clearInflight(header.ID)
		s.executeReadFile(ctx, header)

	case "put", "mkdir", "rename", "rmdir", "copy-exclusive", "set-times":
		defer s.clearInflight(header.ID)
		result := s.executeTargetWrite(header, body)
		if ctx.Err() != nil {
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "cancelled"}, nil)
			return
		}
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: result}, nil)

	case "open-exclusive":
		s.executeOpenExclusive(ctx, header)

	case "read", "delete", "observe", "capture", "apply", "recover", "inspect":
		s.executeConfinedSyncOp(ctx, header, body, applyPipe)

	default:
		defer s.clearInflight(header.ID)
		_ = s.writeFrame(serveResponseFrame{
			V:      1,
			ID:     header.ID,
			T:      "result",
			Result: workspaceTargetError("workspace_root_unsafe", "unknown serve op"),
		}, nil)
	}
}

func (s *workspaceConfinedServer) executeReadFile(ctx context.Context, header serveFrameHeader) {
	path, domainErr := openWorkspaceConfinedUnixPathWithRoot(&s.pinnedRoot, s.rootPath, header.RelativePath, true)
	if domainErr != nil {
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetDomainResult(domainErr)}, nil)
		return
	}
	defer path.close()
	if path.isMissing() {
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetStatus("missing")}, nil)
		return
	}
	final := path.final()
	if final.kind == workspaceConfinedKindSymlink {
		_, linkErr, missing := resolveWorkspaceTargetRealpathWithRoot(&s.pinnedRoot, s.rootPath, header.RelativePath)
		if linkErr != nil {
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetDomainResult(linkErr)}, nil)
			return
		}
		if missing {
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetStatus("missing")}, nil)
			return
		}
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetError("workspace_file_unsupported", "workspace preview supports only regular files")}, nil)
		return
	}
	if final.kind != workspaceConfinedKindFile {
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetError("workspace_file_unsupported", "workspace path is not a regular file")}, nil)
		return
	}
	limit := uint64(serveMaxBodyBytes)
	if header.MaxBytes != nil && *header.MaxBytes < limit {
		limit = *header.MaxBytes
	}
	current, err := inspectWorkspaceConfinedUnixFD(final.fd)
	if err != nil || !workspaceTargetSameObject(current, final) || current.kind != workspaceConfinedKindFile {
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetError("conflict_changed", "workspace file changed before reading")}, nil)
		return
	}
	if current.stat.Size < 0 || uint64(current.stat.Size) > limit {
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetStatus("too_large")}, nil)
		return
	}
	digest, content, _, readErr := readWorkspaceConfinedUnixFile(final, true, limit)
	if readErr != nil {
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetDomainResult(readErr)}, nil)
		return
	}
	if domainErr := path.revalidate(); domainErr != nil {
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetDomainResult(domainErr)}, nil)
		return
	}
	if ctx.Err() != nil {
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "cancelled"}, nil)
		return
	}
	res := workspaceTargetStatus("file")
	res.Digest = digest
	res.Entry = workspaceTargetEntryOf(final)
	_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: res}, content)
}

func (s *workspaceConfinedServer) executeTargetWrite(header serveFrameHeader, body []byte) workspaceTargetResult {
	mode := uint32(0o644)
	if header.Mode != nil {
		if *header.Mode > 0o777 {
			return workspaceTargetError("workspace_root_unsafe", "invalid mode")
		}
		mode = *header.Mode
	}
	req := workspaceTargetWriteRequest{
		rootPath:       s.rootPath,
		relativePath:   header.RelativePath,
		op:             header.Op,
		toRelativePath: header.ToRelativePath,
		sizeBytes:      int64(len(body)),
		mode:           mode,
		expect:         header.Expect,
		recursive:      header.Recursive,
	}
	switch header.Op {
	case "put":
		if req.expect != "absent" && req.expect != "any" && !workspaceTargetSha256Pattern.MatchString(req.expect) {
			return workspaceTargetError("workspace_root_unsafe", "invalid expect")
		}
	case "rename", "copy-exclusive":
		if req.toRelativePath == "" {
			return workspaceTargetError("workspace_root_unsafe", "missing toRelativePath")
		}
	case "set-times":
		if header.AtimeMs == nil || header.MtimeMs == nil {
			return workspaceTargetError("workspace_root_unsafe", "missing timestamps")
		}
		req.atimeMs = *header.AtimeMs
		req.mtimeMs = *header.MtimeMs
	}
	return runWorkspaceTargetWriteWithRoot(&s.pinnedRoot, req, body)
}

func (s *workspaceConfinedServer) executeOpenExclusive(ctx context.Context, header serveFrameHeader) {
	parent, name, domainErr := splitWorkspaceTargetParentWithRoot(&s.pinnedRoot, s.rootPath, header.RelativePath)
	if domainErr != nil {
		s.clearInflight(header.ID)
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetDomainResult(domainErr)}, nil)
		return
	}
	file, result := createExclusiveWorkspaceTargetFile(parent, name, 0o666)
	if file == nil {
		parent.close()
		s.clearInflight(header.ID)
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: result}, nil)
		return
	}
	var stat unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &stat); err != nil {
		_ = file.Close()
		_ = unix.Unlinkat(parent.final().fd, name, 0)
		parent.close()
		s.clearInflight(header.ID)
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: workspaceTargetError("io_failed", "exclusive file mode could not be read")}, nil)
		return
	}
	result.Entry = &workspaceTargetEntry{Mode: uint32(stat.Mode)}

	s.mu.Lock()
	if ctx.Err() != nil {
		delete(s.inflight, header.ID)
		s.mu.Unlock()
		_ = file.Close()
		_ = unix.Unlinkat(parent.final().fd, name, 0)
		parent.close()
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "cancelled"}, nil)
		return
	}
	delete(s.inflight, header.ID)
	s.exclusive[header.ID] = &serveExclusiveOp{parent: parent, name: name, file: file}
	s.mu.Unlock()

	_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "opened", Result: result}, nil)
}

func (s *workspaceConfinedServer) verifyPinnedRequestRoot(requestRoot string) *workspaceConfinedDomainError {
	if filepath.Clean(requestRoot) != s.rootPath {
		return workspaceConfinedError("workspace_root_unsafe", "request root does not match pinned worker root")
	}
	return nil
}

func (s *workspaceConfinedServer) executeConfinedSyncOp(ctx context.Context, header serveFrameHeader, body []byte, applyPipe *serveChunkPipe) {
	if len(header.Request) == 0 {
		s.clearInflight(header.ID)
		_ = s.writeFrame(serveResponseFrame{
			V:      1,
			ID:     header.ID,
			T:      "result",
			Result: workspaceConfinedError("workspace_root_unsafe", "missing confined sync request payload").result(),
		}, nil)
		return
	}

	var op workspaceConfinedPreparedOperation
	var domainErr *workspaceConfinedDomainError
	var stagingDirectory string
	stageOnTarget := false

	switch header.Op {
	case "read":
		req, err := decodeWorkspaceConfinedReadRequest(header.Request)
		if err != nil {
			domainErr = workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined read request")
		} else if domainErr = s.verifyPinnedRequestRoot(req.rootPath); domainErr == nil {
			op, domainErr = prepareWorkspaceConfinedReadWithRoot(&s.pinnedRoot, req)
		}
	case "delete":
		req, err := decodeWorkspaceConfinedDeleteRequest(header.Request)
		if err != nil {
			domainErr = workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined delete request")
		} else if domainErr = s.verifyPinnedRequestRoot(req.rootPath); domainErr == nil {
			op, domainErr = prepareWorkspaceConfinedDeleteWithRoot(&s.pinnedRoot, req)
		}
	case "observe":
		req, err := decodeWorkspaceConfinedObserveRequest(header.Request)
		if err != nil {
			domainErr = workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined observe request")
		} else if domainErr = s.verifyPinnedRequestRoot(req.rootPath); domainErr == nil {
			op, domainErr = prepareWorkspaceConfinedObserveWithRoot(&s.pinnedRoot, req)
		}
	case "capture":
		req, err := decodeWorkspaceConfinedCaptureRequest(header.Request)
		if err != nil {
			domainErr = workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined capture request")
		} else if domainErr = s.verifyPinnedRequestRoot(req.rootPath); domainErr == nil {
			op, domainErr = prepareWorkspaceConfinedCaptureWithRoot(&s.pinnedRoot, req)
		}
	case "apply":
		req, err := decodeWorkspaceConfinedApplyRequest(header.Request)
		if err != nil {
			domainErr = workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined apply request")
		} else if domainErr = s.verifyPinnedRequestRoot(req.rootPath); domainErr == nil {
			stageOnTarget = req.stageOnTarget
			if req.stageOnTarget {
				var materialReader io.Reader
				if applyPipe != nil {
					materialReader = applyPipe
				} else {
					materialReader = bytes.NewReader(body)
				}
				stagingDirectory, domainErr = stageWorkspaceConfinedApply(&req, materialReader)
				if applyPipe != nil {
					applyPipe.finishReader()
				}
			}
			if domainErr == nil {
				op, domainErr = prepareWorkspaceConfinedApplyWithRoot(&s.pinnedRoot, req)
			}
		}
	case "recover":
		req, err := decodeWorkspaceConfinedRecoverRequest(header.Request)
		if err != nil {
			domainErr = workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined recover request")
		} else if domainErr = s.verifyPinnedRequestRoot(req.rootPath); domainErr == nil {
			op, domainErr = prepareWorkspaceConfinedRecoverWithRoot(&s.pinnedRoot, req)
		}
	case "inspect":
		req, err := decodeWorkspaceConfinedInspectRequest(header.Request)
		if err != nil {
			domainErr = workspaceConfinedError("workspace_root_unsafe", "invalid workspace-confined inspect request")
		} else {
			op, domainErr = prepareWorkspaceConfinedInspect(req)
		}
	}

	pending := &servePendingOp{
		op:               op,
		stagingDirectory: stagingDirectory,
		stageOnTarget:    stageOnTarget,
	}

	if ctx.Err() != nil {
		pending.cleanup(false)
		s.clearInflight(header.ID)
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "cancelled"}, nil)
		return
	}
	if domainErr != nil {
		pending.cleanup(false)
		s.clearInflight(header.ID)
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: domainErr.result()}, nil)
		return
	}

	if header.RequireAuthorityCommit {
		s.mu.Lock()
		if ctx.Err() != nil {
			delete(s.inflight, header.ID)
			s.mu.Unlock()
			pending.cleanup(false)
			_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "cancelled"}, nil)
			return
		}
		delete(s.inflight, header.ID)
		s.pending[header.ID] = pending
		s.mu.Unlock()
		_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "prepared"}, nil)
		return
	}

	// 1-RTT immediate fast path when authority commit is not required.
	result := pending.op.commit()
	preserveRecovery := pending.stageOnTarget && result.Status == "recovery_needed"
	pending.cleanup(preserveRecovery)
	s.clearInflight(header.ID)
	_ = s.writeFrame(serveResponseFrame{V: 1, ID: header.ID, T: "result", Result: result}, nil)
}
