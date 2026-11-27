//go:build !linux && !darwin

package main

import (
	"bufio"
	"io"
)

// Target workspace operations are supported on Linux and Darwin hosts/guests.

func runWorkspaceTargetMeta(workspaceTargetMetaRequest) workspaceTargetResult {
	return workspaceTargetError("workspace_root_unsafe", "target workspace operations run in Linux or Darwin targets")
}

func runWorkspaceTargetWrite(workspaceTargetWriteRequest, []byte) workspaceTargetResult {
	return workspaceTargetError("workspace_root_unsafe", "target workspace operations run in Linux or Darwin targets")
}

func openExclusiveWorkspaceTargetFile(_ workspaceTargetWriteRequest, _ *bufio.Reader, output io.Writer) error {
	return writeWorkspaceConfinedRecord(output, workspaceTargetError("workspace_root_unsafe", "target workspace operations run in Linux or Darwin targets"))
}
