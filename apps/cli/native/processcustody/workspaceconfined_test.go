package main

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestWorkspaceConfinedContentResultRetainsEmptyPayload(t *testing.T) {
	emptySize := uint64(0)
	encoded, err := json.Marshal(workspaceConfinedResult{
		V: 1, T: "workspace-confined-result", Status: "content",
		Size: &emptySize, Digest: strings.Repeat("a", 40), ContentBase64: workspaceConfinedString(""),
	})
	if err != nil {
		t.Fatalf("encode empty content result: %v", err)
	}
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatalf("decode empty content result: %v", err)
	}
	if _, present := result["contentBase64"]; !present {
		t.Fatalf("empty content payload was omitted: %s", encoded)
	}
}

func TestDecodeWorkspaceConfinedReadRequestIsClosedAndBounded(t *testing.T) {
	request, err := decodeWorkspaceConfinedReadRequest([]byte(`{"v":1,"rootPath":"C:\\work","relativePath":"src\\index.ts","maxBytes":1048576,"expectedDigest":"0123456789abcdef0123456789abcdef01234567"}`))
	if err != nil {
		t.Fatalf("decode valid request: %v", err)
	}
	if request.rootPath != `C:\work` || request.relativePath != `src\index.ts` || request.maxBytes != 1024*1024 {
		t.Fatalf("unexpected request: %#v", request)
	}

	invalid := []string{
		`{"v":2,"rootPath":"C:\\work","relativePath":"a","maxBytes":1}`,
		`{"v":1,"rootPath":"C:\\work","relativePath":"a","maxBytes":0}`,
		`{"v":1,"rootPath":"C:\\work","relativePath":"a","maxBytes":1,"extra":true}`,
		`{"v":1,"v":1,"rootPath":"C:\\work","relativePath":"a","maxBytes":1}`,
		`{"v":1,"rootPath":"C:\\work","relativePath":"a","maxBytes":1} {}`,
		`{"v":1,"rootPath":"C:\\work","relativePath":"a","maxBytes":1,"expectedDigest":"ABC"}`,
	}
	for _, encoded := range invalid {
		if _, err := decodeWorkspaceConfinedReadRequest([]byte(encoded)); err == nil {
			t.Fatalf("accepted invalid read request: %s", encoded)
		}
	}
}

func TestWorkspaceConfinedReadAcceptsTransferSizeBeyondPreview(t *testing.T) {
	request, err := decodeWorkspaceConfinedReadRequest([]byte(`{"v":1,"rootPath":"C:\\work","relativePath":"large.bin","maxBytes":1048577}`))
	if err != nil || request.maxBytes != 1048577 {
		t.Fatalf("transfer read must retain its caller-owned size: %#v %v", request, err)
	}
}

func TestDecodeWorkspaceConfinedDeleteRequestIsClosed(t *testing.T) {
	request, err := decodeWorkspaceConfinedDeleteRequest([]byte(`{"v":1,"rootPath":"C:\\work","relativePath":"loser","expectedKind":"directory"}`))
	if err != nil {
		t.Fatalf("decode valid request: %v", err)
	}
	if request.expectedKind != workspaceConfinedKindDirectory {
		t.Fatalf("unexpected expected kind: %q", request.expectedKind)
	}

	invalid := []string{
		`{"v":1,"rootPath":"C:\\work","relativePath":"loser","expectedKind":"other"}`,
		`{"v":1,"rootPath":"C:\\work","relativePath":"loser"}`,
		`{"v":1,"rootPath":"C:\\work","relativePath":"loser","expectedKind":"file"}`,
		`{"v":1,"rootPath":"C:\\work","relativePath":"loser","expectedKind":"file","expectedDigest":null}`,
		`{"v":1,"rootPath":"C:\\work","relativePath":"loser","expectedKind":"directory","expectedDigest":"0123456789abcdef0123456789abcdef01234567"}`,
		`{"v":1,"rootPath":"C:\\work","relativePath":"loser","expectedKind":"file","extra":1}`,
	}
	for _, encoded := range invalid {
		if _, err := decodeWorkspaceConfinedDeleteRequest([]byte(encoded)); err == nil {
			t.Fatalf("accepted invalid delete request: %s", encoded)
		}
	}
}

func TestDecodeWorkspaceConfinedDecisionAcceptsOnlyExactCommitOrAbort(t *testing.T) {
	for _, decision := range []string{"commit", "abort"} {
		got, err := decodeWorkspaceConfinedDecision([]byte(`{"v":1,"decision":"` + decision + `"}`))
		if err != nil || got != decision {
			t.Fatalf("decode %s: got %q, %v", decision, got, err)
		}
	}
	for _, encoded := range []string{
		`{"v":2,"decision":"commit"}`,
		`{"v":1,"decision":"continue"}`,
		`{"v":1,"decision":"commit","extra":true}`,
		`{"v":1,"decision":"commit","decision":"abort"}`,
	} {
		if _, err := decodeWorkspaceConfinedDecision([]byte(encoded)); err == nil {
			t.Fatalf("accepted invalid decision: %s", encoded)
		}
	}
}

func TestWorkspaceConfinedCommandRejectsArgumentsBeforeReadingInput(t *testing.T) {
	var output strings.Builder
	err := workspaceConfinedReadCommand([]string{"unexpected"}, strings.NewReader(""), &output)
	if err == nil {
		t.Fatal("expected command arguments to be rejected")
	}
	if output.Len() != 0 {
		t.Fatalf("unexpected protocol output: %q", output.String())
	}
}

type stubWorkspaceConfinedOperation struct {
	committed int
	closed    int
	res       workspaceConfinedResult
}

func (s *stubWorkspaceConfinedOperation) commit() workspaceConfinedResult {
	s.committed++
	return s.res
}

func (s *stubWorkspaceConfinedOperation) close() {
	s.closed++
}

func TestWorkspaceConfinedExchangeAutoCommitSkipsPreparedHandshake(t *testing.T) {
	op := &stubWorkspaceConfinedOperation{res: workspaceConfinedSuccess("deleted")}
	var output strings.Builder
	err := runWorkspaceConfinedExchange(
		[]string{"--auto-commit"},
		strings.NewReader(`{"v":1}`+"\n"),
		&output,
		func(_ []byte, _ io.Reader) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
			return op, nil
		},
	)
	if err != nil {
		t.Fatalf("auto-commit exchange failed: %v", err)
	}
	if op.committed != 1 || op.closed != 1 {
		t.Fatalf("expected 1 commit and 1 close, got committed=%d closed=%d", op.committed, op.closed)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected exactly 1 output line (no prepared handshake), got %d: %q", len(lines), output.String())
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &record); err != nil {
		t.Fatalf("invalid JSON result: %v", err)
	}
	if record["t"] != "workspace-confined-result" || record["status"] != "deleted" {
		t.Fatalf("unexpected auto-commit record: %v", record)
	}

	var rejectedOutput strings.Builder
	if err := runWorkspaceConfinedExchange(
		[]string{"--auto-commit", "extra"},
		strings.NewReader(""),
		&rejectedOutput,
		func(_ []byte, _ io.Reader) (workspaceConfinedPreparedOperation, *workspaceConfinedDomainError) {
			t.Fatal("decoder should not be called when extra args are present")
			return nil, nil
		},
	); err == nil || rejectedOutput.Len() != 0 {
		t.Fatalf("expected extra args rejection with empty output, err=%v out=%q", err, rejectedOutput.String())
	}
}
