//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestPosixWorkspaceConfinedRelativePathPreservesExactPOSIXComponents(t *testing.T) {
	components, domainErr := validateWorkspaceConfinedDarwinRelativePath(` nested/ note\file `)
	if domainErr != nil {
		t.Fatalf("exact POSIX path rejected: %v", domainErr)
	}
	if len(components) != 2 || components[0] != " nested" || components[1] != ` note\file ` {
		t.Fatalf("path components were normalized: %#v", components)
	}
}

func TestPosixWorkspaceConfinedObserveCaptureApplyAndRecover(t *testing.T) {
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

	observeReader, observeInput, observeDone := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedObserveCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "selected",
	})
	observed := decidePosixWorkspaceConfinedExchange(t, observeReader, observeInput, observeDone, "commit")
	selected := observed["expectation"]
	if observed["status"] != "observed" || selected == nil {
		t.Fatalf("unexpected observation: %#v", observed)
	}
	captureReader, captureInput, captureDone := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedCaptureCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "selected", "expected": selected,
		"captureDirectory": captureDirectory, "operationId": "native-e2e",
	})
	captured := decidePosixWorkspaceConfinedExchange(t, captureReader, captureInput, captureDone, "commit")
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

	applyReader, applyInput, applyDone := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedApplyCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "destination", "expectedDestination": destination,
		"selectedExpectation": selected, "materialPath": materialPath, "recoveryDirectory": recoveryDirectory,
		"operationId": "native-e2e",
	})
	applied := decidePosixWorkspaceConfinedExchange(t, applyReader, applyInput, applyDone, "commit")
	if applied["status"] != "installed" {
		t.Fatalf("unexpected apply: %#v", applied)
	}
	if content, err := os.ReadFile(filepath.Join(root, "destination", "child")); err != nil || string(content) != "selected bytes" {
		t.Fatalf("selected directory was not installed: %q %v", content, err)
	}

	recoverReader, recoverInput, recoverDone := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedRecoverCommand, map[string]any{
		"v": 1, "rootPath": root, "recoveryDirectory": recoveryDirectory, "operationId": "native-e2e",
	})
	recovered := decidePosixWorkspaceConfinedExchange(t, recoverReader, recoverInput, recoverDone, "commit")
	if recovered["status"] != "settled" {
		t.Fatalf("completed apply left recovery blocked: %#v", recovered)
	}
}

func TestPosixWorkspaceConfinedRecoverRetainsChangedDisplacedEntry(t *testing.T) {
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
	reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedRecoverCommand, map[string]any{"v": 1, "rootPath": root, "recoveryDirectory": recovery, "operationId": "op"})
	result := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "recovery_needed" {
		t.Fatalf("changed displaced entry was settled: %#v", result)
	}
	if content, err := os.ReadFile(priorPath); err != nil || string(content) != "unreviewed" {
		t.Fatalf("changed displaced bytes were removed: %q %v", content, err)
	}
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
	reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "loser", "expectedKind": "directory",
	})
	result := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
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
