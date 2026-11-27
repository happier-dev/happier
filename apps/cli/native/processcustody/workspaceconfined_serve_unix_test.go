//go:build linux || darwin

package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"sync/atomic"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type testServeHarness struct {
	t      *testing.T
	inW    *io.PipeWriter
	outR   *bufio.Reader
	done   chan error
	closed bool
}

func startTestServe(t *testing.T, rootPath string) *testServeHarness {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := workspaceConfinedServeCommand([]string{"--root", rootPath}, inR, outW)
		_ = outW.Close()
		_ = inR.Close()
		done <- err
	}()
	h := &testServeHarness{
		t:    t,
		inW:  inW,
		outR: bufio.NewReader(outR),
		done: done,
	}
	frame, body := h.readFrame()
	if frame.T != "workspace-confined-serve-ready" || len(body) != 0 {
		t.Fatalf("expected ready frame, got %+v (body=%d)", frame, len(body))
	}
	return h
}

func (h *testServeHarness) send(header map[string]any, body []byte) {
	h.t.Helper()
	header["v"] = 1
	if len(body) > 0 {
		header["bodyBytes"] = len(body)
	}
	encoded, err := json.Marshal(header)
	if err != nil {
		h.t.Fatalf("marshal header: %v", err)
	}
	if _, err := h.inW.Write(append(encoded, '\n')); err != nil {
		h.t.Fatalf("write header: %v", err)
	}
	if len(body) > 0 {
		if _, err := h.inW.Write(body); err != nil {
			h.t.Fatalf("write body: %v", err)
		}
	}
}

func (h *testServeHarness) readFrame() (serveResponseFrame, []byte) {
	h.t.Helper()
	line, err := readServeHeaderLine(h.outR)
	if err != nil {
		h.t.Fatalf("read response header: %v", err)
	}
	var frame serveResponseFrame
	if err := json.Unmarshal(line, &frame); err != nil {
		h.t.Fatalf("unmarshal response header %q: %v", string(line), err)
	}
	var body []byte
	if frame.BodyBytes > 0 {
		body = make([]byte, frame.BodyBytes)
		if _, err := io.ReadFull(h.outR, body); err != nil {
			h.t.Fatalf("read response body: %v", err)
		}
	}
	return frame, body
}

func (h *testServeHarness) closeAndWait() error {
	h.t.Helper()
	if !h.closed {
		h.closed = true
		_ = h.inW.Close()
	}
	select {
	case err := <-h.done:
		return err
	case <-time.After(5 * time.Second):
		h.t.Fatal("timed out waiting for workspace-confined-serve shutdown")
		return nil
	}
}

func decodeResultMap(t *testing.T, v any) map[string]any {
	t.Helper()
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("expected map result, got %T (%v)", v, v)
	}
	return m
}

func makeSingleFileTar(t *testing.T, name string, content []byte, mode int64) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tw.WriteHeader(&tar.Header{
		Name:     "./" + name,
		Mode:     mode,
		Size:     int64(len(content)),
		Typeflag: tar.TypeReg,
	}); err != nil {
		t.Fatalf("tar header: %v", err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatalf("tar body: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	return buf.Bytes()
}

func sha1Hex(data []byte) string {
	sum := sha1.Sum(data)
	return hex.EncodeToString(sum[:])
}

func TestWorkspaceConfinedServeCoreAndBatchOps(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello world"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "run.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("a.txt", filepath.Join(root, "in-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/hostname", filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}

	srv := startTestServe(t, root)
	defer func() {
		if err := srv.closeAndWait(); err != nil {
			t.Fatalf("clean EOF exit failed: %v", err)
		}
	}()

	// 1. stat / lstat / readdir / readlink / realpath / access-executable
	srv.send(map[string]any{"id": "1", "op": "stat", "relativePath": "a.txt"}, nil)
	f, _ := srv.readFrame()
	res := decodeResultMap(t, f.Result)
	if f.ID != "1" || res["status"] != "entry" {
		t.Fatalf("unexpected stat result: %+v", f)
	}

	srv.send(map[string]any{"id": "2", "op": "readFile", "relativePath": "a.txt"}, nil)
	f, body := srv.readFrame()
	if f.ID != "2" || string(body) != "hello world" {
		t.Fatalf("unexpected readFile: %+v body=%q", f, string(body))
	}

	srv.send(map[string]any{"id": "3", "op": "readdir", "relativePath": ""}, nil)
	f, _ = srv.readFrame()
	res = decodeResultMap(t, f.Result)
	if res["status"] != "entries" {
		t.Fatalf("unexpected readdir: %+v", res)
	}

	srv.send(map[string]any{"id": "4", "op": "readlink", "relativePath": "in-link"}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["target"] != "a.txt" {
		t.Fatalf("unexpected readlink: %+v", f.Result)
	}

	srv.send(map[string]any{"id": "5", "op": "realpath", "relativePath": "in-link"}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["path"] != "a.txt" {
		t.Fatalf("unexpected realpath: %+v", f.Result)
	}

	srv.send(map[string]any{"id": "6", "op": "access-executable", "relativePath": "run.sh"}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "done" {
		t.Fatalf("unexpected access-executable: %+v", f.Result)
	}

	// 2. mkdir / put / rename / copy-exclusive / set-times / rmdir
	srv.send(map[string]any{"id": "7", "op": "mkdir", "relativePath": "dir/sub", "recursive": true}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "done" {
		t.Fatalf("unexpected mkdir: %+v", f.Result)
	}

	srv.send(map[string]any{"id": "8", "op": "put", "relativePath": "dir/sub/p.txt", "expect": "absent"}, []byte("payload-bytes"))
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "written" {
		t.Fatalf("unexpected put: %+v", f.Result)
	}

	srv.send(map[string]any{"id": "9", "op": "rename", "relativePath": "dir/sub/p.txt", "toRelativePath": "dir/moved.txt"}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "done" {
		t.Fatalf("unexpected rename: %+v", f.Result)
	}

	srv.send(map[string]any{"id": "10", "op": "copy-exclusive", "relativePath": "dir/moved.txt", "toRelativePath": "dir/copied.txt"}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "done" {
		t.Fatalf("unexpected copy-exclusive: %+v", f.Result)
	}

	srv.send(map[string]any{"id": "11", "op": "set-times", "relativePath": "dir/copied.txt", "atimeMs": int64(1700000000000), "mtimeMs": int64(1700000001000)}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "done" {
		t.Fatalf("unexpected set-times: %+v", f.Result)
	}

	srv.send(map[string]any{"id": "12", "op": "rmdir", "relativePath": "dir/sub"}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "done" {
		t.Fatalf("unexpected rmdir: %+v", f.Result)
	}

	// 3. open-exclusive 2-step
	srv.send(map[string]any{"id": "13", "op": "open-exclusive", "relativePath": "dir/excl.txt"}, nil)
	f, _ = srv.readFrame()
	if f.T != "opened" {
		t.Fatalf("expected opened frame, got %+v", f)
	}
	srv.send(map[string]any{"id": "13", "op": "open-exclusive-finish", "relativePath": "dir/moved.txt", "mode": 0o640}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "done" {
		t.Fatalf("unexpected open-exclusive-finish: %+v", f.Result)
	}
	gotExcl, err := os.ReadFile(filepath.Join(root, "dir/excl.txt"))
	if err != nil || string(gotExcl) != "payload-bytes" {
		t.Fatalf("exclusive file content mismatch: %q (%v)", string(gotExcl), err)
	}

	// 4. statBatch & captureBatch
	srv.send(map[string]any{"id": "14", "op": "statBatch", "paths": []string{"a.txt", "missing.txt", "escape", "../outside"}}, nil)
	f, _ = srv.readFrame()
	if len(f.Results) != 4 || f.Results[0].Status != "entry" || f.Results[1].Status != "missing" ||
		f.Results[2].Code != "workspace_root_unsafe" || f.Results[3].Code != "workspace_root_unsafe" {
		t.Fatalf("unexpected statBatch results: %+v", f.Results)
	}

	srv.send(map[string]any{"id": "15", "op": "captureBatch", "paths": []string{"a.txt", "in-link", "missing.txt"}}, nil)
	f, _ = srv.readFrame()
	if len(f.Results) != 3 || f.Results[0].Status != "leaf" || f.Results[0].ContentBase64 == nil ||
		f.Results[1].Status != "link" || f.Results[2].Status != "missing" {
		t.Fatalf("unexpected captureBatch results: %+v", f.Results)
	}
	decoded, err := base64.StdEncoding.DecodeString(*f.Results[0].ContentBase64)
	if err != nil || string(decoded) != "hello world" {
		t.Fatalf("captureBatch content mismatch: %q (%v)", string(decoded), err)
	}

	// 5. observe + delete (1-RTT immediate)
	srv.send(map[string]any{"id": "16", "op": "observe", "request": map[string]any{"v": 1, "rootPath": root, "relativePath": "dir/copied.txt"}}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "observed" {
		t.Fatalf("unexpected observe: %+v", f.Result)
	}
	srv.send(map[string]any{"id": "17", "op": "delete", "request": map[string]any{
		"v": 1, "rootPath": root, "relativePath": "dir/copied.txt",
		"expectedKind": "file", "expectedDigest": sha1Hex([]byte("payload-bytes")),
	}}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "deleted" {
		t.Fatalf("unexpected delete: %+v", f.Result)
	}
}

func TestWorkspaceConfinedServeSecurityConfinementAndRootRename(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "workspace")
	moved := filepath.Join(base, "workspace-moved")
	outside := filepath.Join(base, "outside.txt")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "orig.txt"), []byte("PINNED-ORIGINAL"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "pinned.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "attacker.txt"), filepath.Join(root, "abs-to-old-root")); err != nil {
		t.Fatal(err)
	}

	srv := startTestServe(t, root)
	defer func() {
		if err := srv.closeAndWait(); err != nil {
			t.Fatalf("shutdown error: %v", err)
		}
	}()

	// Symlink escape and .. traversal are blocked.
	for _, tc := range []struct {
		id  string
		op  string
		rel string
	}{
		{"s1", "stat", "escape"},
		{"s2", "readFile", "escape"},
		{"s3", "stat", "../outside.txt"},
		{"s4", "readFile", "../outside.txt"},
		{"s5", "put", "../outside.txt"},
	} {
		req := map[string]any{"id": tc.id, "op": tc.op, "relativePath": tc.rel}
		if tc.op == "put" {
			req["expect"] = "any"
		}
		srv.send(req, nil)
		f, _ := srv.readFrame()
		res := decodeResultMap(t, f.Result)
		if res["status"] != "error" || res["code"] != "workspace_root_unsafe" {
			t.Fatalf("expected workspace_root_unsafe for %+v, got %+v", tc, res)
		}
	}

	// Rename the root directory after startup and plant a decoy directory at the old path.
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "orig.txt"), []byte("ATTACKER-DECOY"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "pinned.sh"), []byte("not-exec-decoy"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "attacker.txt"), []byte("ATTACKER-ONLY"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Reads still come from the original pinned dirfd (now at moved), NEVER from the decoy at root!
	srv.send(map[string]any{"id": "r1", "op": "readFile", "relativePath": "orig.txt"}, nil)
	f, body := srv.readFrame()
	if string(body) != "PINNED-ORIGINAL" {
		t.Fatalf("root rename hijacked readFile! got %q (frame=%+v)", string(body), f)
	}

	// Attacker file in decoy dir is invisible (missing).
	srv.send(map[string]any{"id": "r2", "op": "stat", "relativePath": "attacker.txt"}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "missing" {
		t.Fatalf("root rename leaked decoy file: %+v", f.Result)
	}

	// Absolute symlink pointing to the old root string path is refused because old root is now a different inode.
	srv.send(map[string]any{"id": "r3", "op": "stat", "relativePath": "abs-to-old-root"}, nil)
	f, _ = srv.readFrame()
	if res := decodeResultMap(t, f.Result); res["status"] != "error" || res["code"] != "workspace_root_unsafe" {
		t.Fatalf("absolute symlink to swapped root was not blocked: %+v", res)
	}

	// Writes go strictly into the pinned dirfd (moved), never the decoy directory.
	srv.send(map[string]any{"id": "r4", "op": "put", "relativePath": "written.txt", "expect": "absent"}, []byte("PINNED-WRITE"))
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "written" {
		t.Fatalf("put after root rename failed: %+v", f.Result)
	}
	gotMoved, err := os.ReadFile(filepath.Join(moved, "written.txt"))
	if err != nil || string(gotMoved) != "PINNED-WRITE" {
		t.Fatalf("expected write inside pinned dirfd (moved), got %q (%v)", string(gotMoved), err)
	}
	if _, err := os.Stat(filepath.Join(root, "written.txt")); !os.IsNotExist(err) {
		t.Fatalf("write leaked into decoy root directory!")
	}

	// access-executable also stays pinned to the original dirfd (where pinned.sh is 0755, not the 0644 decoy).
	srv.send(map[string]any{"id": "r5", "op": "access-executable", "relativePath": "pinned.sh"}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "done" {
		t.Fatalf("access-executable after root rename failed to use pinned dirfd: %+v", f.Result)
	}
	srv.send(map[string]any{"id": "r6", "op": "access-executable", "relativePath": ""}, nil)
	f, _ = srv.readFrame()
	if decodeResultMap(t, f.Result)["status"] != "done" {
		t.Fatalf("access-executable on pinned root after rename failed: %+v", f.Result)
	}
}

func TestWorkspaceConfinedServeTwoPhaseAuthorityFenceAndCancel(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := t.TempDir()
	before := []byte("before\n")
	after := []byte("after\n")
	if err := os.WriteFile(filepath.Join(root, "file.txt"), before, 0o644); err != nil {
		t.Fatal(err)
	}

	srv := startTestServe(t, root)
	defer func() {
		if err := srv.closeAndWait(); err != nil {
			t.Fatalf("shutdown error: %v", err)
		}
	}()

	makeApplyReq := func(opID string) map[string]any {
		return map[string]any{
			"v":            1,
			"rootPath":     root,
			"relativePath": "file.txt",
			"expectedDestination": map[string]any{
				"kind": "file", "digest": sha1Hex(before), "executable": false, "size": len(before),
			},
			"selectedExpectation": map[string]any{
				"kind": "file", "digest": sha1Hex(after), "executable": false, "size": len(after),
			},
			"stageOnTarget": true,
			"materialPath":  "file.txt",
			"operationId":   opID,
		}
	}

	// 1. requireAuthorityCommit: true -> abort must leave file untouched and clean up staging dir.
	tarBytes := makeSingleFileTar(t, "file.txt", after, 0o644)
	srv.send(map[string]any{
		"id":                     "a1",
		"op":                     "apply",
		"requireAuthorityCommit": true,
		"request":                makeApplyReq("op-abort-1"),
	}, tarBytes)
	f, _ := srv.readFrame()
	if f.ID != "a1" || f.T != "prepared" {
		t.Fatalf("expected prepared frame, got %+v", f)
	}
	// File must NOT be mutated before commit!
	disk, _ := os.ReadFile(filepath.Join(root, "file.txt"))
	if string(disk) != string(before) {
		t.Fatalf("file mutated before commit: %q", string(disk))
	}
	srv.send(map[string]any{"id": "a1", "op": "abort"}, nil)
	f, _ = srv.readFrame()
	if f.ID != "a1" || f.T != "aborted" {
		t.Fatalf("expected aborted frame, got %+v", f)
	}
	disk, _ = os.ReadFile(filepath.Join(root, "file.txt"))
	if string(disk) != string(before) {
		t.Fatalf("file mutated after abort: %q", string(disk))
	}
	stagingParent := filepath.Join(home, ".happier", "workspace-sync")
	if entries, err := os.ReadDir(stagingParent); err == nil && len(entries) != 0 {
		t.Fatalf("abort leaked staging directories: %v", entries)
	}

	// 2. requireAuthorityCommit: true with streaming tar chunks -> cancel cleans up cleanly.
	srv.send(map[string]any{
		"id":                     "a2",
		"op":                     "apply",
		"requireAuthorityCommit": true,
		"streamMaterial":         true,
		"request":                makeApplyReq("op-cancel-2"),
	}, nil)
	srv.send(map[string]any{"id": "a2", "op": "apply-chunk"}, tarBytes[:len(tarBytes)/2])
	srv.send(map[string]any{"id": "a2", "op": "apply-chunk"}, tarBytes[len(tarBytes)/2:])
	f, _ = srv.readFrame()
	if f.ID != "a2" || f.T != "prepared" {
		t.Fatalf("expected prepared frame for streamed apply, got %+v", f)
	}
	srv.send(map[string]any{"id": "a2", "op": "cancel"}, nil)
	f, _ = srv.readFrame()
	if f.ID != "a2" || f.T != "cancelled" {
		t.Fatalf("expected cancelled frame, got %+v", f)
	}

	// 3. requireAuthorityCommit: true -> commit installs file atomically.
	srv.send(map[string]any{
		"id":                     "a3",
		"op":                     "apply",
		"requireAuthorityCommit": true,
		"request":                makeApplyReq("op-commit-3"),
	}, tarBytes)
	f, _ = srv.readFrame()
	if f.ID != "a3" || f.T != "prepared" {
		t.Fatalf("expected prepared frame, got %+v", f)
	}
	srv.send(map[string]any{"id": "a3", "op": "commit"}, nil)
	f, _ = srv.readFrame()
	if res := decodeResultMap(t, f.Result); res["status"] != "installed" {
		t.Fatalf("expected installed, got %+v", res)
	}
	disk, _ = os.ReadFile(filepath.Join(root, "file.txt"))
	if string(disk) != string(after) {
		t.Fatalf("expected after content, got %q", string(disk))
	}

	// 4. requireAuthorityCommit: false -> 1-RTT immediate apply without prepared frame.
	after2 := []byte("after-immediate\n")
	tarBytes2 := makeSingleFileTar(t, "file.txt", after2, 0o644)
	srv.send(map[string]any{
		"id":                     "a4",
		"op":                     "apply",
		"requireAuthorityCommit": false,
		"request": map[string]any{
			"v":            1,
			"rootPath":     root,
			"relativePath": "file.txt",
			"expectedDestination": map[string]any{
				"kind": "file", "digest": sha1Hex(after), "executable": false, "size": len(after),
			},
			"selectedExpectation": map[string]any{
				"kind": "file", "digest": sha1Hex(after2), "executable": false, "size": len(after2),
			},
			"stageOnTarget": true,
			"materialPath":  "file.txt",
			"operationId":   "op-fast-4",
		},
	}, tarBytes2)
	f, _ = srv.readFrame()
	if f.T != "result" || decodeResultMap(t, f.Result)["status"] != "installed" {
		t.Fatalf("expected direct 1-RTT installed result, got %+v", f)
	}
	disk, _ = os.ReadFile(filepath.Join(root, "file.txt"))
	if string(disk) != string(after2) {
		t.Fatalf("expected after2 content, got %q", string(disk))
	}
}

func TestWorkspaceConfinedServeMaxBodyBytesAligned(t *testing.T) {
	const wantMaxBodyBytes = 128 * 1024 * 1024
	if serveMaxBodyBytes != wantMaxBodyBytes {
		t.Fatalf("serveMaxBodyBytes = %d, want %d (aligned with TS frame decoder)", serveMaxBodyBytes, wantMaxBodyBytes)
	}

	root := t.TempDir()
	payload := bytes.Repeat([]byte("A"), 4096)
	if err := os.WriteFile(filepath.Join(root, "big.bin"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	srv := startTestServe(t, root)
	defer func() { _ = srv.closeAndWait() }()

	// Oversized readFile returns status:"too_large" cleanly without closing the worker.
	srv.send(map[string]any{"id": "tl1", "op": "readFile", "relativePath": "big.bin", "maxBytes": 1024}, nil)
	f, body := srv.readFrame()
	res := decodeResultMap(t, f.Result)
	if f.ID != "tl1" || f.T != "result" || res["status"] != "too_large" || len(body) != 0 {
		t.Fatalf("expected clean too_large result with empty body, got frame=%+v res=%+v bodyLen=%d", f, res, len(body))
	}

	// Subsequent requests still succeed on the same persistent worker.
	srv.send(map[string]any{"id": "tl2", "op": "stat", "relativePath": "big.bin"}, nil)
	f, _ = srv.readFrame()
	if res := decodeResultMap(t, f.Result); f.ID != "tl2" || res["status"] != "entry" {
		t.Fatalf("expected worker to remain alive after too_large, got %+v", f)
	}
}

func TestWorkspaceConfinedServeStreamPipeBufferCapsNonBlocking(t *testing.T) {
	// 1. Direct unit test: per-pipe cap, aggregate cap, non-blocking push, backing-array reset, and zero counter drift.
	var total atomic.Int64
	p1 := newServeChunkPipe(100, &total, 150)
	p1.push(bytes.Repeat([]byte("a"), 60))
	p1.push(bytes.Repeat([]byte("b"), 40))
	if got := total.Load(); got != 100 {
		t.Fatalf("expected totalQueued=100, got %d", got)
	}

	// Read all 100 bytes and confirm backing slice capacity is released when drained.
	buf := make([]byte, 128)
	n1, err := p1.Read(buf)
	if err != nil || n1 != 60 {
		t.Fatalf("read1: n=%d err=%v", n1, err)
	}
	n2, err := p1.Read(buf)
	if err != nil || n2 != 40 {
		t.Fatalf("read2: n=%d err=%v", n2, err)
	}
	p1.mu.Lock()
	chunksCap := cap(p1.chunks)
	p1.mu.Unlock()
	if chunksCap != 0 {
		t.Fatalf("expected p1.chunks backing array reset (cap=0), got cap=%d", chunksCap)
	}
	if got := total.Load(); got != 0 {
		t.Fatalf("expected totalQueued=0 after drain, got %d", got)
	}

	// Overflow per-pipe cap: must fail closed without blocking and release queued bytes.
	p1.push(bytes.Repeat([]byte("x"), 70))
	p1.push(bytes.Repeat([]byte("y"), 50)) // 70+50=120 > 100 -> aborts p1 non-blocking
	p1.push(bytes.Repeat([]byte("z"), 10)) // dropped cleanly
	if got := total.Load(); got != 0 {
		t.Fatalf("expected totalQueued=0 after per-pipe overflow abort, got %d", got)
	}
	if _, err := p1.Read(buf); !errors.Is(err, errStreamBufferExceeded) {
		t.Fatalf("expected errStreamBufferExceeded, got %v", err)
	}

	// Aggregate cap across two active pipes: p2 holds 90 bytes, p3 trying 70 bytes exceeds aggregate 150.
	p2 := newServeChunkPipe(100, &total, 150)
	p3 := newServeChunkPipe(100, &total, 150)
	p2.push(bytes.Repeat([]byte("m"), 90))
	p3.push(bytes.Repeat([]byte("n"), 70)) // 90+70=160 > 150 -> aborts ONLY p3
	if _, err := p3.Read(buf); !errors.Is(err, errStreamBufferExceeded) {
		t.Fatalf("expected aggregate cap abort on p3, got %v", err)
	}
	if got := total.Load(); got != 90 {
		t.Fatalf("expected p2 bytes still reserved (90), got %d", got)
	}
	p2.finishReader()
	if got := total.Load(); got != 0 {
		t.Fatalf("expected totalQueued=0 after p2 finishReader, got %d", got)
	}

	// 2. End-to-end server test with small stream cap: oversized stream fails closed without deadlocking control ops.
	root := t.TempDir()
	before := []byte("before\n")
	if err := os.WriteFile(filepath.Join(root, "file.txt"), before, 0o644); err != nil {
		t.Fatal(err)
	}
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := runWorkspaceConfinedServeWithOptions(root, inR, outW, serveServerOptions{
			maxStreamPipeBytes:      128,
			maxTotalStreamPipeBytes: 256,
		})
		_ = outW.Close()
		_ = inR.Close()
		done <- err
	}()
	srv := &testServeHarness{t: t, inW: inW, outR: bufio.NewReader(outR), done: done}
	defer func() { _ = srv.closeAndWait() }()
	if ready, _ := srv.readFrame(); ready.T != "workspace-confined-serve-ready" {
		t.Fatalf("expected ready, got %+v", ready)
	}

	after := bytes.Repeat([]byte("Q"), 2048)
	srv.send(map[string]any{
		"id":                     "big-stream",
		"op":                     "apply",
		"requireAuthorityCommit": true,
		"streamMaterial":         true,
		"request": map[string]any{
			"v":            1,
			"rootPath":     root,
			"relativePath": "file.txt",
			"expectedDestination": map[string]any{
				"kind": "file", "digest": sha1Hex(before), "executable": false, "size": len(before),
			},
			"selectedExpectation": map[string]any{
				"kind": "file", "digest": sha1Hex(after), "executable": false, "size": len(after),
			},
			"stageOnTarget": true,
			"materialPath":  "file.txt",
			"operationId":   "op-overflow",
		},
	}, nil)
	// Push a single 512-byte chunk exceeding the 128-byte per-pipe cap, then immediately send a stat.
	srv.send(map[string]any{"id": "big-stream", "op": "apply-chunk"}, bytes.Repeat([]byte("X"), 512))
	srv.send(map[string]any{"id": "stat-after", "op": "stat", "relativePath": "file.txt"}, nil)

	seen := map[string]serveResponseFrame{}
	for len(seen) < 2 {
		f, _ := srv.readFrame()
		seen[f.ID] = f
	}
	if res := decodeResultMap(t, seen["big-stream"].Result); res["status"] != "error" {
		t.Fatalf("expected oversized stream apply to fail closed with error, got %+v", res)
	}
	if res := decodeResultMap(t, seen["stat-after"].Result); res["status"] != "entry" {
		t.Fatalf("expected concurrent stat to succeed without deadlock, got %+v", res)
	}
}

func TestWorkspaceConfinedServeDuplicateIDPendingExclusiveAndAbortInflight(t *testing.T) {
	root := t.TempDir()
	before := []byte("before-content\n")
	if err := os.WriteFile(filepath.Join(root, "file.txt"), before, 0o644); err != nil {
		t.Fatal(err)
	}

	srv := startTestServe(t, root)
	defer func() { _ = srv.closeAndWait() }()

	// 1. Park a 2-phase delete in s.pending["dup-pending"] and send a duplicate ID while parked.
	srv.send(map[string]any{
		"id":                     "dup-pending",
		"op":                     "delete",
		"requireAuthorityCommit": true,
		"request": map[string]any{
			"v":              1,
			"rootPath":       root,
			"relativePath":   "file.txt",
			"expectedKind":   "file",
			"expectedDigest": sha1Hex(before),
		},
	}, nil)
	f, _ := srv.readFrame()
	if f.ID != "dup-pending" || f.T != "prepared" {
		t.Fatalf("expected prepared frame for dup-pending, got %+v", f)
	}

	srv.send(map[string]any{"id": "dup-pending", "op": "stat", "relativePath": "file.txt"}, nil)
	f, _ = srv.readFrame()
	res := decodeResultMap(t, f.Result)
	if f.ID != "dup-pending" || f.T != "result" || res["status"] != "error" || res["message"] != "duplicate request id" {
		t.Fatalf("expected duplicate request id error against parked pending op, got frame=%+v res=%+v", f, res)
	}

	// Original parked op must remain intact and cleanly abortable.
	srv.send(map[string]any{"id": "dup-pending", "op": "abort"}, nil)
	f, _ = srv.readFrame()
	if f.ID != "dup-pending" || f.T != "aborted" {
		t.Fatalf("expected aborted for original dup-pending, got %+v", f)
	}

	// 2. Park an open-exclusive in s.exclusive["dup-ex"] and send a duplicate ID while parked.
	srv.send(map[string]any{"id": "dup-ex", "op": "open-exclusive", "relativePath": "excl.txt"}, nil)
	f, _ = srv.readFrame()
	if f.ID != "dup-ex" || f.T != "opened" {
		t.Fatalf("expected opened frame for dup-ex, got %+v", f)
	}

	srv.send(map[string]any{"id": "dup-ex", "op": "stat", "relativePath": "file.txt"}, nil)
	f, _ = srv.readFrame()
	res = decodeResultMap(t, f.Result)
	if f.ID != "dup-ex" || f.T != "result" || res["status"] != "error" || res["message"] != "duplicate request id" {
		t.Fatalf("expected duplicate request id error against parked exclusive op, got frame=%+v res=%+v", f, res)
	}

	// Original open-exclusive must still finish cleanly.
	srv.send(map[string]any{"id": "dup-ex", "op": "open-exclusive-finish"}, nil)
	f, _ = srv.readFrame()
	if res := decodeResultMap(t, f.Result); f.ID != "dup-ex" || res["status"] != "done" {
		t.Fatalf("expected done for dup-ex finish, got %+v", f)
	}

	// 3. Send abort while a streaming 2-phase apply is still in-flight (staging):
	// handleAbort must cancel the in-flight prepare and NEVER park a leaked entry in s.pending.
	after := []byte("after-inflight-abort\n")
	tarBytes := makeSingleFileTar(t, "file.txt", after, 0o644)
	srv.send(map[string]any{
		"id":                     "abort-inflight",
		"op":                     "apply",
		"requireAuthorityCommit": true,
		"streamMaterial":         true,
		"request": map[string]any{
			"v":            1,
			"rootPath":     root,
			"relativePath": "file.txt",
			"expectedDestination": map[string]any{
				"kind": "file", "digest": sha1Hex(before), "executable": false, "size": len(before),
			},
			"selectedExpectation": map[string]any{
				"kind": "file", "digest": sha1Hex(after), "executable": false, "size": len(after),
			},
			"stageOnTarget": true,
			"materialPath":  "file.txt",
			"operationId":   "op-abort-inflight",
		},
	}, nil)
	// Send only partial tar bytes so prepare is genuinely in-flight waiting on stream.
	srv.send(map[string]any{"id": "abort-inflight", "op": "apply-chunk"}, tarBytes[:len(tarBytes)/2])
	srv.send(map[string]any{"id": "abort-inflight", "op": "abort"}, nil)

	f, _ = srv.readFrame()
	if f.ID != "abort-inflight" || (f.T != "cancelled" && f.T != "aborted") {
		t.Fatalf("expected single cancelled/aborted frame for abort-inflight, got %+v", f)
	}

	// Confirm no leaked pending op exists for abort-inflight, and no stray second frame was emitted.
	srv.send(map[string]any{"id": "abort-inflight", "op": "commit"}, nil)
	f, _ = srv.readFrame()
	res = decodeResultMap(t, f.Result)
	if f.ID != "abort-inflight" || f.T != "result" || res["status"] != "error" || res["message"] != "no prepared workspace operation for commit" {
		t.Fatalf("expected no prepared op after inflight abort (and no extra stray frame), got frame=%+v res=%+v", f, res)
	}
}
