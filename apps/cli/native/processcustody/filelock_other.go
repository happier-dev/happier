//go:build !linux && !darwin

package main

import "errors"

func fileLockCommand(_ []string) error {
	return errors.New("file-lock is unavailable on this platform")
}
