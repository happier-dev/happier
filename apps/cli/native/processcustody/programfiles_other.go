//go:build !windows

package main

import "fmt"

func windowsProgramFilesCommand(args []string) error {
	return fmt.Errorf("windows-program-files is only available on Windows")
}
