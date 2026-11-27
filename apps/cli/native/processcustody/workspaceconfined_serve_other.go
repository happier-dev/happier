//go:build !linux && !darwin

package main

import (
	"fmt"
	"io"
)

func runWorkspaceConfinedServe(_ string, _ io.Reader, output io.Writer) error {
	_ = writeWorkspaceConfinedRecord(output, serveResponseFrame{
		V:       1,
		T:       "workspace-confined-serve-error",
		Code:    "workspace_root_unsafe",
		Message: "workspace-confined-serve is only supported on Linux and Darwin",
	})
	return fmt.Errorf("workspace-confined-serve is only supported on Linux and Darwin")
}
