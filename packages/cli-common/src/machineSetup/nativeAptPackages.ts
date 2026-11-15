/** Decode dpkg's installed state once for update review and exact package effects. */
export function readNativeAptPackages(stdout: string) {
    const packages: { name: string; version: string; architecture: string; configurationPending: boolean }[] = [];
    for (const line of stdout.trim().split(/\r?\n/).filter(Boolean)) {
        const [nativeId, status, version, architecture, ...extra] = line.split('\t');
        if (!nativeId || !status || extra.length) return null;
        if (/^(?:unknown|install|hold|deinstall|purge) ok not-installed$/u.test(status)
            || /^(?:deinstall|purge) ok config-files$/u.test(status)) continue;
        const [name, ...qualifiers] = nativeId.split(':');
        if (!name || !version || !architecture || qualifiers.length > 1
            || qualifiers.length === 1 && qualifiers[0] !== architecture) return null;
        const state = /^(?:unknown|install|hold|deinstall|purge) ok (installed|unpacked|half-configured)$/u.exec(status)?.[1];
        if (!state) return null;
        // dpkg --configure accepts unpacked, not-yet-configured packages. Other
        // incomplete/error states need administrator diagnosis, not this repair.
        const configurationPending = state !== 'installed';
        packages.push({ name, version, architecture, configurationPending });
    }
    return packages;
}
