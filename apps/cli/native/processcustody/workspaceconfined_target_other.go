//go:build !linux

package main

import (
	"bufio"
	"io"
)

// Session execution targets are Linux guests; other hosts keep their own workspace owners.

func runWorkspaceTargetMeta(workspaceTargetMetaRequest) workspaceTargetResult {
	return workspaceTargetError("workspace_root_unsafe", "target workspace operations run in Linux targets")
}

func runWorkspaceTargetWrite(workspaceTargetWriteRequest, []byte) workspaceTargetResult {
	return workspaceTargetError("workspace_root_unsafe", "target workspace operations run in Linux targets")
}

func openExclusiveWorkspaceTargetFile(_ workspaceTargetWriteRequest, _ *bufio.Reader, output io.Writer) error {
	return writeWorkspaceConfinedRecord(output, workspaceTargetError("workspace_root_unsafe", "target workspace operations run in Linux targets"))
}
