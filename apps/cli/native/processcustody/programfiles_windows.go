//go:build windows

package main

import (
	"fmt"
	"golang.org/x/sys/windows"
)

func windowsProgramFilesPath() (string, error) {
	// The same FOLDERID and DONT_VERIFY flag as the Bun KnownFolder adapter.
	return windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, windows.KF_FLAG_DONT_VERIFY)
}

func windowsProgramFilesCommand(args []string) error {
	if len(args) != 0 {
		return fmt.Errorf("windows-program-files accepts no arguments")
	}
	path, err := windowsProgramFilesPath()
	if err != nil {
		return err
	}
	return emit(map[string]any{"path": path})
}
