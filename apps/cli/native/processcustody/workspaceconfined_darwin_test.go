//go:build darwin

package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestDarwinWorkspaceConfinedRelativePathPreservesExactPOSIXComponents(t *testing.T) {
	components, domainErr := validateWorkspaceConfinedDarwinRelativePath(` nested/ note\file `)
	if domainErr != nil {
		t.Fatalf("exact POSIX path rejected: %v", domainErr)
	}
	if len(components) != 2 || components[0] != " nested" || components[1] != ` note\file ` {
		t.Fatalf("path components were normalized: %#v", components)
	}
}

func beginDarwinWorkspaceConfinedExchange(t *testing.T, command func([]string, io.Reader, io.Writer) error, request any) (*bufio.Reader, *io.PipeWriter, <-chan error) {
	t.Helper()
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- command(nil, inputReader, outputWriter)
		_ = outputWriter.Close()
	}()
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	if _, err := inputWriter.Write(append(encoded, '\n')); err != nil {
		t.Fatalf("write request: %v", err)
	}
	reader := bufio.NewReader(outputReader)
	prepared, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read prepared line: %v", err)
	}
	if prepared != "{\"v\":1,\"t\":\"workspace-confined-prepared\"}\n" {
		t.Fatalf("unexpected prepared line: %q", prepared)
	}
	return reader, inputWriter, done
}

func decideDarwinWorkspaceConfinedExchange(t *testing.T, reader *bufio.Reader, input *io.PipeWriter, done <-chan error, decision string) map[string]any {
	t.Helper()
	if _, err := io.WriteString(input, `{"v":1,"decision":"`+decision+`"}`+"\n"); err != nil {
		t.Fatalf("write decision: %v", err)
	}
	_ = input.Close()
	if decision == "abort" {
		if err := <-done; err != nil {
			t.Fatalf("abort command failed: %v", err)
		}
		return nil
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read result: %v", err)
	}
	var result map[string]any
	if err := json.Unmarshal([]byte(line), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("command failed: %v", err)
	}
	return result
}

func darwinWorkspaceConfinedDigest(content []byte) string {
	digest := sha1.Sum(content)
	return hex.EncodeToString(digest[:])
}

func TestDarwinWorkspaceConfinedReadHoldsAndReadsExactFile(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	content := []byte("hello from darwin")
	if err := os.WriteFile(filepath.Join(root, "nested", "preview.txt"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := darwinWorkspaceConfinedDigest(content)
	reader, input, done := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "nested/preview.txt", "maxBytes": 64, "expectedDigest": digest,
	})
	result := decideDarwinWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "content" || result["digest"] != digest || result["contentBase64"] != base64.StdEncoding.EncodeToString(content) {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestDarwinWorkspaceConfinedReadRejectsAncestorRenameAndSymlinkReplacement(t *testing.T) {
	root := t.TempDir()
	ancestor := filepath.Join(root, "ancestor")
	if err := os.Mkdir(ancestor, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ancestor, "preview.txt"), []byte("approved"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	secret := []byte("must not escape")
	if err := os.WriteFile(filepath.Join(outside, "preview.txt"), secret, 0o600); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "ancestor/preview.txt", "maxBytes": 64,
	})
	if err := os.Rename(ancestor, filepath.Join(root, "approved-renamed")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, ancestor); err != nil {
		t.Fatal(err)
	}
	result := decideDarwinWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "error" || result["code"] != "conflict_changed" || result["contentBase64"] != nil {
		t.Fatalf("ancestor replacement did not fail closed: %#v", result)
	}
}

func TestDarwinWorkspaceConfinedReadRejectsFinalReplacement(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "preview.txt")
	if err := os.WriteFile(path, []byte("approved"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "preview.txt", "maxBytes": 64,
	})
	if err := os.Rename(path, path+".renamed"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := decideDarwinWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "error" || result["code"] != "conflict_changed" || result["contentBase64"] != nil {
		t.Fatalf("final replacement did not fail closed: %#v", result)
	}
}

func TestDarwinWorkspaceConfinedReadUsesCurrentSizeAfterPrepared(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "preview.txt")
	if err := os.WriteFile(path, []byte("content that starts above the preview limit"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "preview.txt", "maxBytes": 8,
	})
	if err := os.WriteFile(path, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := decideDarwinWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "content" || result["contentBase64"] != base64.StdEncoding.EncodeToString([]byte("short")) {
		t.Fatalf("commit used stale prepared size: %#v", result)
	}
}

func TestDarwinWorkspaceConfinedReadRejectsTraversalAndSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, relativePath := range []string{"", ".", "..", "../secret.txt", "nested/../../secret.txt", "/absolute", "a//b"} {
		var output strings.Builder
		request, err := json.Marshal(map[string]any{"v": 1, "rootPath": root, "relativePath": relativePath, "maxBytes": 64})
		if err != nil {
			t.Fatal(err)
		}
		if err := workspaceConfinedReadCommand(nil, strings.NewReader(string(request)+"\n"), &output); err != nil {
			t.Fatalf("command transport failed for %q: %v", relativePath, err)
		}
		if !strings.Contains(output.String(), `"status":"error"`) || !strings.Contains(output.String(), `"code":"workspace_root_unsafe"`) {
			t.Fatalf("unsafe path %q was not rejected: %s", relativePath, output.String())
		}
		if strings.Contains(output.String(), "workspace-confined-prepared") {
			t.Fatalf("unsafe path %q reached prepared: %s", relativePath, output.String())
		}
	}

	var output strings.Builder
	request, err := json.Marshal(map[string]any{"v": 1, "rootPath": root, "relativePath": "escape/secret.txt", "maxBytes": 64})
	if err != nil {
		t.Fatal(err)
	}
	if err := workspaceConfinedReadCommand(nil, strings.NewReader(string(request)+"\n"), &output); err != nil {
		t.Fatalf("symlink escape command failed: %v", err)
	}
	if !strings.Contains(output.String(), `"status":"error"`) || strings.Contains(output.String(), "workspace-confined-prepared") {
		t.Fatalf("intermediate symlink escape was not rejected before prepared: %s", output.String())
	}
}

func TestDarwinWorkspaceConfinedDeleteAbortDoesNotMutate(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "loser.txt")
	content := []byte("keep")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "loser.txt", "expectedKind": "file", "expectedDigest": darwinWorkspaceConfinedDigest(content),
	})
	decideDarwinWorkspaceConfinedExchange(t, reader, input, done, "abort")
	observed, err := os.ReadFile(path)
	if err != nil || string(observed) != string(content) {
		t.Fatalf("abort mutated file: content=%q err=%v", observed, err)
	}
}

func TestDarwinWorkspaceConfinedDeleteRecursesWithoutFollowingSymlinks(t *testing.T) {
	root := t.TempDir()
	loser := filepath.Join(root, "loser")
	if err := os.MkdirAll(filepath.Join(loser, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(loser, "nested", "file.txt"), []byte("delete"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "keep.txt")
	if err := os.WriteFile(outsideFile, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(loser, "outside-link")); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "loser", "expectedKind": "directory",
	})
	result := decideDarwinWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "deleted" {
		t.Fatalf("unexpected delete result: %#v", result)
	}
	if _, err := os.Lstat(loser); !os.IsNotExist(err) {
		t.Fatalf("loser still exists: %v", err)
	}
	if content, err := os.ReadFile(outsideFile); err != nil || string(content) != "keep" {
		t.Fatalf("recursive delete followed symlink: content=%q err=%v", content, err)
	}
}

func TestDarwinWorkspaceConfinedDeleteRejectsAncestorAndFinalReplacement(t *testing.T) {
	t.Run("ancestor", func(t *testing.T) {
		root := t.TempDir()
		ancestor := filepath.Join(root, "ancestor")
		if err := os.Mkdir(ancestor, 0o700); err != nil {
			t.Fatal(err)
		}
		content := []byte("delete")
		if err := os.WriteFile(filepath.Join(ancestor, "loser.txt"), content, 0o600); err != nil {
			t.Fatal(err)
		}
		outside := t.TempDir()
		outsideFile := filepath.Join(outside, "loser.txt")
		if err := os.WriteFile(outsideFile, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		reader, input, done := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
			"v": 1, "rootPath": root, "relativePath": "ancestor/loser.txt", "expectedKind": "file", "expectedDigest": darwinWorkspaceConfinedDigest(content),
		})
		if err := os.Rename(ancestor, filepath.Join(root, "ancestor-renamed")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, ancestor); err != nil {
			t.Fatal(err)
		}
		result := decideDarwinWorkspaceConfinedExchange(t, reader, input, done, "commit")
		if result["status"] != "error" || result["code"] != "conflict_changed" {
			t.Fatalf("ancestor replacement did not fail closed: %#v", result)
		}
		if content, err := os.ReadFile(outsideFile); err != nil || string(content) != "outside" {
			t.Fatalf("outside replacement was mutated: content=%q err=%v", content, err)
		}
	})

	t.Run("final", func(t *testing.T) {
		root := t.TempDir()
		path := filepath.Join(root, "loser.txt")
		content := []byte("delete")
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
		reader, input, done := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
			"v": 1, "rootPath": root, "relativePath": "loser.txt", "expectedKind": "file", "expectedDigest": darwinWorkspaceConfinedDigest(content),
		})
		if err := os.Rename(path, path+".renamed"); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
			t.Fatal(err)
		}
		result := decideDarwinWorkspaceConfinedExchange(t, reader, input, done, "commit")
		if result["status"] != "error" || result["code"] != "conflict_changed" {
			t.Fatalf("final replacement did not fail closed: %#v", result)
		}
		if content, err := os.ReadFile(path); err != nil || string(content) != "replacement" {
			t.Fatalf("replacement was mutated: content=%q err=%v", content, err)
		}
	})
}

func TestDarwinWorkspaceConfinedDeletePreservesQuarantineAndReportsPhysicalRecoveryPath(t *testing.T) {
	root := t.TempDir()
	loser := filepath.Join(root, "loser")
	if err := os.Mkdir(loser, 0o700); err != nil {
		t.Fatal(err)
	}
	blocked := filepath.Join(loser, "blocked.txt")
	if err := os.WriteFile(blocked, []byte("keep for recovery"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := unix.Chflags(blocked, unix.UF_IMMUTABLE); err != nil {
		t.Fatalf("mark immutable: %v", err)
	}
	var recoveryPath string
	t.Cleanup(func() {
		_ = unix.Chflags(blocked, 0)
		if recoveryPath != "" {
			_ = unix.Chflags(filepath.Join(recoveryPath, "blocked.txt"), 0)
		}
		quarantined, _ := filepath.Glob(filepath.Join(root, ".happier-conflict-quarantine-*", "blocked.txt"))
		for _, path := range quarantined {
			_ = unix.Chflags(path, 0)
		}
	})
	reader, input, done := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "loser", "expectedKind": "directory",
	})
	result := decideDarwinWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "error" || result["code"] != "conflict_changed" {
		t.Fatalf("immutable descendant did not preserve a recovery quarantine: %#v", result)
	}
	var ok bool
	recoveryPath, ok = result["recoveryPath"].(string)
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatalf("resolve physical fixture root: %v", err)
	}
	if !ok || recoveryPath == "" || !filepath.IsAbs(recoveryPath) || filepath.Dir(recoveryPath) != canonicalRoot {
		t.Fatalf("unexpected physical recovery path: %#v", result)
	}
	if _, err := os.Lstat(loser); !os.IsNotExist(err) {
		t.Fatalf("original loser name was restored or retained: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(recoveryPath, "blocked.txt")); err != nil {
		t.Fatalf("quarantined recovery material missing: %v", err)
	}
	if err := unix.Chflags(filepath.Join(recoveryPath, "blocked.txt"), 0); err != nil {
		t.Fatalf("clear immutable recovery fixture: %v", err)
	}
}

func TestDarwinWorkspaceConfinedObserveCaptureApplyAndRecover(t *testing.T) {
	root := t.TempDir()
	captureDirectory := t.TempDir()
	recoveryDirectory := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "selected"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "selected", "child"), []byte("selected bytes"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "destination"), []byte("old bytes"), 0o600); err != nil {
		t.Fatal(err)
	}

	observeReader, observeInput, observeDone := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedObserveCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "selected",
	})
	observed := decideDarwinWorkspaceConfinedExchange(t, observeReader, observeInput, observeDone, "commit")
	selected := observed["expectation"]
	if observed["status"] != "observed" || selected == nil {
		t.Fatalf("unexpected observation: %#v", observed)
	}
	heldDebug, debugDomainErr := openWorkspaceConfinedDarwinHeldPath(root, "selected")
	if debugDomainErr != nil {
		t.Fatalf("open debug source: %#v", debugDomainErr)
	}
	debugParent, debugName, debugTarget := darwinHeldParentNameTarget(heldDebug)
	debugPath := filepath.Join(captureDirectory, "debug")
	if err := copyWorkspaceConfinedDarwinHandle(debugParent.fd, debugName, *debugTarget, debugPath); err != nil {
		t.Fatalf("copy debug source: %v", err)
	}
	debugSource, _ := observeWorkspaceConfinedDarwinHeldPath(heldDebug)
	debugMaterial, debugMaterialErr := observeWorkspaceConfinedPrivateMaterial(debugPath)
	heldDebug.close()
	if debugMaterialErr != nil || !workspaceConfinedExpectationsEqual(debugSource, debugMaterial) {
		heldChild, _ := openWorkspaceConfinedDarwinHeldPath(root, "selected/child")
		sourceChild, _ := observeWorkspaceConfinedDarwinHeldPath(heldChild)
		heldChild.close()
		materialChild, _ := observeWorkspaceConfinedPrivateMaterial(filepath.Join(debugPath, "child"))
		t.Fatalf("captured material differs: source=%#v material=%#v sourceChild=%#v materialChild=%#v err=%v", debugSource, debugMaterial, sourceChild, materialChild, debugMaterialErr)
	}
	if err := removeWorkspaceConfinedPrivateMaterial(debugPath); err != nil {
		t.Fatal(err)
	}

	captureReader, captureInput, captureDone := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedCaptureCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "selected", "expected": selected,
		"captureDirectory": captureDirectory, "operationId": "native-e2e",
	})
	captured := decideDarwinWorkspaceConfinedExchange(t, captureReader, captureInput, captureDone, "commit")
	materialPath, ok := captured["materialPath"].(string)
	if captured["status"] != "captured" || !ok {
		materialExpectation, materialErr := observeWorkspaceConfinedPrivateMaterial(workspaceConfinedMaterialPath(captureDirectory, "native-e2e"))
		currentPath, currentDomainErr := openWorkspaceConfinedDarwinHeldPath(root, "selected")
		var currentExpectation workspaceConfinedExpectation
		if currentDomainErr == nil {
			currentExpectation, _ = observeWorkspaceConfinedDarwinHeldPath(currentPath)
			currentPath.close()
		}
		t.Fatalf("unexpected capture: %#v; material=%#v/%v current=%#v/%#v", captured, materialExpectation, materialErr, currentExpectation, currentDomainErr)
	}
	destination, err := observeWorkspaceConfinedPrivateMaterial(filepath.Join(root, "destination"))
	if err != nil {
		t.Fatal(err)
	}

	applyReader, applyInput, applyDone := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedApplyCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "destination", "expectedDestination": destination,
		"selectedExpectation": selected, "materialPath": materialPath, "recoveryDirectory": recoveryDirectory,
		"operationId": "native-e2e",
	})
	applied := decideDarwinWorkspaceConfinedExchange(t, applyReader, applyInput, applyDone, "commit")
	if applied["status"] != "installed" {
		t.Fatalf("unexpected apply: %#v", applied)
	}
	if content, err := os.ReadFile(filepath.Join(root, "destination", "child")); err != nil || string(content) != "selected bytes" {
		t.Fatalf("selected directory was not installed: %q %v", content, err)
	}

	recoverReader, recoverInput, recoverDone := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedRecoverCommand, map[string]any{
		"v": 1, "rootPath": root, "recoveryDirectory": recoveryDirectory, "operationId": "native-e2e",
	})
	recovered := decideDarwinWorkspaceConfinedExchange(t, recoverReader, recoverInput, recoverDone, "commit")
	if recovered["status"] != "settled" {
		t.Fatalf("completed apply left recovery blocked: %#v", recovered)
	}
}

func TestDarwinWorkspaceConfinedObserveMeasuresRegularFilesWithoutFollowingSymlinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "copy", ".cache", "compiler"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "copy", "source"), []byte("copy"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "copy", ".cache", "compiler", "warm"), make([]byte, 17), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "private"), make([]byte, 4096), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "copy", "outside")); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedObserveCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "copy", "measureSize": true,
	})
	measured := decideDarwinWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if measured["status"] != "measured" || measured["sizeBytes"] != float64(21) || measured["expectation"] != nil {
		t.Fatalf("unexpected passive measurement: %#v", measured)
	}
}

func TestDarwinWorkspaceConfinedRecoverRetainsChangedDisplacedEntry(t *testing.T) {
	root := t.TempDir()
	recovery := t.TempDir()
	priorName := ".happier-conflict-resolution-op-prior"
	priorPath := filepath.Join(root, priorName)
	if err := os.WriteFile(priorPath, []byte("reviewed"), 0o600); err != nil {
		t.Fatal(err)
	}
	prior, _ := observeWorkspaceConfinedPrivateMaterial(priorPath)
	if err := os.WriteFile(filepath.Join(root, "entry"), []byte("selected"), 0o600); err != nil {
		t.Fatal(err)
	}
	selected, _ := observeWorkspaceConfinedPrivateMaterial(filepath.Join(root, "entry"))
	held, domainErr := openWorkspaceConfinedDarwinHeldPath(root, "entry")
	if domainErr != nil {
		t.Fatal(domainErr)
	}
	identity := darwinWorkspaceConfinedIdentity(held.handles[0])
	held.close()
	record := workspaceConfinedRecoveryRecord{V: 1, OperationID: "op", RootPath: root, RootIdentity: identity, RelativePath: "entry", ExpectedDestination: prior, SelectedExpectation: selected, CandidateName: ".happier-conflict-resolution-op-selected", PriorName: priorName}
	if err := workspaceConfinedWriteRecoveryRecord(workspaceConfinedRecoveryRecordPath(recovery, "op"), record); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(priorPath, []byte("unreviewed"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginDarwinWorkspaceConfinedExchange(t, workspaceConfinedRecoverCommand, map[string]any{"v": 1, "rootPath": root, "recoveryDirectory": recovery, "operationId": "op"})
	result := decideDarwinWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "recovery_needed" {
		t.Fatalf("changed displaced entry was settled: %#v", result)
	}
	if content, err := os.ReadFile(priorPath); err != nil || string(content) != "unreviewed" {
		t.Fatalf("changed displaced bytes were removed: %q %v", content, err)
	}
}
