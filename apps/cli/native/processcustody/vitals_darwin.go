//go:build darwin

package main

import (
	"encoding/binary"
	"fmt"
	"net"
	"path/filepath"
	"regexp"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

func readNativeVitals(extras bool) (vitalsNativeSample, error) {
	s := vitalsNativeSample{}
	total, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return s, err
	}
	// The JS host reads allocation headroom through os.freemem(), also used by
	// Lume. kern.memorystatus_level includes active pages; it is not free RAM.
	s.Memory = vitalsMemory{TotalBytes: total, PressureLevel: "not_reported", PressureSource: "none"}
	if level, err := unix.SysctlUint32("kern.memorystatus_vm_pressure_level"); err == nil {
		switch level {
		case 1:
			s.Memory.PressureLevel = "calm"
		case 2:
			s.Memory.PressureLevel = "elevated"
		case 4:
			s.Memory.PressureLevel = "critical"
		}
		if s.Memory.PressureLevel != "not_reported" {
			s.Memory.PressureSource = "kernel_level"
		}
	}
	if raw, err := unix.SysctlRaw("vm.swapusage"); err == nil && len(raw) >= 32 {
		s.Memory.Swap = &vitalsSwap{Kind: "swap", TotalBytes: binary.NativeEndian.Uint64(raw[0:8]), UsedBytes: binary.NativeEndian.Uint64(raw[16:24])}
		// Available on current Darwin kernels; absence never invents swap traffic.
		if n, err := unix.SysctlUint64("vm.compressor.swapper.swapins_total"); err == nil {
			s.Memory.Swap.In = &n
		}
		if n, err := unix.SysctlUint64("vm.compressor.swapper.swapouts_total"); err == nil {
			s.Memory.Swap.Out = &n
		}
	}
	levels := []vitalsPerfLevel{}
	if count, err := unix.SysctlUint32("hw.nperflevels"); err == nil {
		for index := uint32(0); index < count; index++ {
			name, nameErr := unix.Sysctl(fmt.Sprintf("hw.perflevel%d.name", index))
			cores, coresErr := unix.SysctlUint32(fmt.Sprintf("hw.perflevel%d.physicalcpu", index))
			if nameErr == nil && coresErr == nil {
				levels = append(levels, vitalsPerfLevel{name, cores})
			}
		}
	}
	s.PerformanceCores, s.EfficiencyCores = darwinVitalsCoreCounts(levels)
	var fileLimit unix.Rlimit
	if unix.Getrlimit(unix.RLIMIT_NOFILE, &fileLimit) == nil && fileLimit.Cur != unix.RLIM_INFINITY {
		s.DaemonFileSoftLimit = &fileLimit.Cur
	}
	// Counts only: perflevel sysctls do not establish a logical-index mapping.
	s.Limits = make(map[string]vitalsLimit)
	if used, err := unix.SysctlUint32("kern.num_files"); err == nil {
		if max, err := unix.SysctlUint32("kern.maxfiles"); err == nil {
			s.Limits["files"] = vitalsLimit{uint64(used), uint64(max)}
		}
	}
	if max, err := unix.SysctlUint32("kern.maxproc"); err == nil {
		if procs, err := unix.SysctlKinfoProcSlice("kern.proc.all"); err == nil {
			s.Limits["processes"] = vitalsLimit{uint64(len(procs)), uint64(max)}
		}
	}
	s.Volumes, err = readDarwinVitalsVolumes()
	if err != nil {
		return s, err
	}
	s.Interfaces, err = readDarwinVitalsInterfaces()
	return s, err
}

var apfsVitalsDevice = regexp.MustCompile(`^/dev/(disk[0-9]+)s[0-9]+`)

func readDarwinVitalsMounts() ([]unix.Statfs_t, error) {
	n, err := unix.Getfsstat(nil, unix.MNT_NOWAIT)
	if err != nil {
		return nil, err
	}
	stats := make([]unix.Statfs_t, n)
	n, err = unix.Getfsstat(stats, unix.MNT_NOWAIT)
	if err != nil {
		return nil, err
	}
	return stats[:n], nil
}

func darwinVitalsAPFSContainer(st unix.Statfs_t) string {
	if nativeCString(st.Fstypename[:]) == "apfs" {
		if match := apfsVitalsDevice.FindStringSubmatch(nativeCString(st.Mntfromname[:])); match != nil {
			return match[1]
		}
	}
	return ""
}

func readDarwinVitalsVolumes() ([]vitalsVolume, error) {
	stats, err := readDarwinVitalsMounts()
	if err != nil {
		return nil, err
	}
	volumes := []vitalsVolume{}
	seen := make(map[string]int)
	for _, st := range stats {
		mount := nativeCString(st.Mntonname[:])
		if st.Flags&unix.MNT_LOCAL == 0 || (mount != "/" && mount != "/System/Volumes/Data" && !strings.HasPrefix(mount, "/Volumes/")) {
			continue
		}
		// Installer images cannot accept writes, even when they advertise free blocks.
		// Retain the sealed boot member; the writable Data member replaces it below.
		if st.Flags&unix.MNT_RDONLY != 0 && mount != "/" {
			continue
		}
		id := fmt.Sprintf("%d:%d", st.Fsid.Val[0], st.Fsid.Val[1])
		container := darwinVitalsAPFSContainer(st)
		if container != "" {
			id = "apfs:" + container
		}
		v := vitalsVolume{ID: id, Mount: mount, Label: filepath.Base(mount), TotalBytes: st.Blocks * uint64(st.Bsize), AvailableBytes: st.Bavail * uint64(st.Bsize), APFSContainerID: container, InodesExhausted: st.Files > 0 && st.Ffree == 0}
		if mount == "/" || mount == "/System/Volumes/Data" {
			v.Mount = "/"
			v.Label = "Startup disk"
		}
		if previous, ok := seen[id]; ok {
			// The writable Data member has free-now figures for the sealed boot volume.
			if mount == "/System/Volumes/Data" {
				volumes[previous] = v
			}
			continue
		}
		seen[id] = len(volumes)
		volumes = append(volumes, v)
	}
	return volumes, nil
}

func nativeCString(bytes []byte) string {
	for i, c := range bytes {
		if c == 0 {
			return string(bytes[:i])
		}
	}
	return string(bytes)
}

func readDarwinVitalsInterfaces() ([]vitalsInterface, error) {
	names, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	bridgeMembers, err := darwinVitalsBridgeMembers(names)
	if err != nil {
		return nil, err
	}
	bondMembers, err := darwinVitalsBondMembers(names)
	if err != nil {
		return nil, err
	}
	result := []vitalsInterface{}
	for _, iface := range names {
		// Public net.link.generic.ifdata.<index>.general, from if_mib.h.
		// Unlike NET_RT_IFLIST2, this keeps 64-bit bytes for non-Apple-signed callers.
		raw, err := sysctlBuffer([]uint32{unix.CTL_NET, unix.AF_LINK, 0, 2, uint32(iface.Index), 1})
		if err != nil {
			return nil, err
		}
		// ifmibdata's if_data64 is packed(4), starting at byte 52.
		if len(raw) < 180 || nativeCString(raw[:16]) != iface.Name {
			return nil, fmt.Errorf("invalid ifmibdata for %s", iface.Name)
		}
		result = append(result, vitalsInterface{ID: fmt.Sprintf("%d:%s", iface.Index, iface.Name), Name: iface.Name,
			RxBytes: binary.NativeEndian.Uint64(raw[116:124]), TxBytes: binary.NativeEndian.Uint64(raw[124:132]),
			Included: iface.Flags&net.FlagLoopback == 0 && includeVitalsInterface(iface.Name) && !bridgeMembers[iface.Name] && !bondMembers[iface.Name]})
	}
	return result, nil
}

// Darwin if_bridgevar.h: BRDGGIFS uses packed(4) ifbifconf/ifbreq via ifdrv.
func darwinVitalsBridgeMembers(interfaces []net.Interface) (map[string]bool, error) {
	members := make(map[string]bool)
	for _, iface := range interfaces {
		if !strings.HasPrefix(iface.Name, "bridge") {
			continue
		}
		fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM, 0)
		if err != nil {
			return nil, err
		}
		rows := make([]byte, len(interfaces)*80)
		conf := make([]byte, 12)
		binary.NativeEndian.PutUint32(conf[:4], uint32(len(rows)))
		binary.NativeEndian.PutUint64(conf[4:], uint64(uintptr(unsafe.Pointer(&rows[0]))))
		request := make([]byte, 40)
		copy(request[:16], iface.Name)
		binary.NativeEndian.PutUint64(request[16:24], 6)
		binary.NativeEndian.PutUint64(request[24:32], uint64(len(conf)))
		binary.NativeEndian.PutUint64(request[32:], uint64(uintptr(unsafe.Pointer(&conf[0]))))
		_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), unix.SIOCGDRVSPEC, uintptr(unsafe.Pointer(&request[0])))
		unix.Close(fd)
		if errno != 0 {
			return nil, fmt.Errorf("bridge members %s: %w", iface.Name, errno)
		}
		length := int(binary.NativeEndian.Uint32(conf[:4]))
		if length > len(rows) || length%80 != 0 {
			return nil, fmt.Errorf("invalid bridge member response")
		}
		for offset := 0; offset < length; offset += 80 {
			members[nativeCString(rows[offset:offset+16])] = true
		}
	}
	return members, nil
}

// if_bond_var.h's read-only IF_BOND_OP_GET_STATUS, version 1.
func darwinVitalsBondMembers(interfaces []net.Interface) (map[string]bool, error) {
	members := make(map[string]bool)
	for _, iface := range interfaces {
		if !strings.HasPrefix(iface.Name, "bond") {
			continue
		}
		fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM, 0)
		if err != nil {
			return nil, err
		}
		rows := make([]byte, len(interfaces)*68)
		status := make([]byte, 40)
		binary.NativeEndian.PutUint32(status[:4], 3)
		binary.NativeEndian.PutUint32(status[4:8], 1)
		binary.NativeEndian.PutUint32(status[12:16], uint32(len(interfaces)))
		binary.NativeEndian.PutUint64(status[16:24], uint64(uintptr(unsafe.Pointer(&rows[0]))))
		request := make([]byte, 32)
		copy(request[:16], iface.Name)
		binary.NativeEndian.PutUint64(request[16:24], uint64(uintptr(unsafe.Pointer(&status[0]))))
		_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), unix.SIOCGIFBOND, uintptr(unsafe.Pointer(&request[0])))
		unix.Close(fd)
		if errno != 0 {
			return nil, fmt.Errorf("bond members %s: %w", iface.Name, errno)
		}
		count := int(binary.NativeEndian.Uint32(status[8:12]))
		if count > len(interfaces) {
			return nil, fmt.Errorf("bond membership changed during enumeration")
		}
		for index := 0; index < count; index++ {
			members[nativeCString(rows[index*68:index*68+16])] = true
		}
	}
	return members, nil
}
