//go:build !windows

package main

import "fmt"

func heldLaunch([]string) error { return fmt.Errorf("held-launch is only available on Windows") }
