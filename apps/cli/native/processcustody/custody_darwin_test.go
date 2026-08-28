//go:build darwin

package main

import (
	"encoding/binary"
	"testing"
)

func TestLocateStarttimeRequiresExactlyOneCandidate(t *testing.T) {
	build := func(sec uint64, usec uint32) []byte {
		buffer := make([]byte, 648)
		binary.LittleEndian.PutUint32(buffer[kinfoProcPidOffset:], 4242)
		// Place the candidate at an 8-aligned offset well past the pid field.
		binary.LittleEndian.PutUint64(buffer[80:], sec)
		binary.LittleEndian.PutUint32(buffer[88:], usec)
		return buffer
	}
	sec, usec, err := locateStarttime(build(1754041400, 123456), 4242, 1754041300, 1754041500)
	if err != nil || sec != 1754041400 || usec != 123456 {
		t.Fatalf("expected the single candidate, got sec=%d usec=%d err=%v", sec, usec, err)
	}
	if _, _, err := locateStarttime(build(1754041400, 123456), 9999, 1754041300, 1754041500); err == nil {
		t.Fatalf("a pid-field mismatch must fail closed")
	}
	if _, _, err := locateStarttime(build(1754041600, 123456), 4242, 1754041300, 1754041500); err == nil {
		t.Fatalf("an out-of-range seconds value must fail closed")
	}
	ambiguous := build(1754041400, 123456)
	binary.LittleEndian.PutUint64(ambiguous[160:], 1754041401)
	binary.LittleEndian.PutUint32(ambiguous[168:], 654321)
	if _, _, err := locateStarttime(ambiguous, 4242, 1754041300, 1754041500); err == nil {
		t.Fatalf("two candidates must fail closed")
	}
}
