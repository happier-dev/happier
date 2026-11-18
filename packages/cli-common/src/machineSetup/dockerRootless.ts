const launcher = '/usr/local/bin/happier-docker-rootless';

/** Docker owns the socket and persists its endpoint in the user's rootless context.
 * Keep the shared daemon running: existing applications may still use it.
 * Contract: https://docs.docker.com/engine/security/rootless/ */
const installTemplate = "#!/bin/sh\nset -eu\nusername='{daemonUsername}'\n";
const installBody = `
if [ "$#" -eq 1 ] && [ "$1" = --check ]; then
    if [ "$(id -un)" = "$username" ]; then
        docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}'
    else
        runuser -u "$username" -- docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}'
    fi | grep -qx 'name=rootless'
    exit "$?"
fi
# Ubuntu restricts unprofiled user namespaces. Grant only this user's official
# RootlessKit executable; never disable the host's AppArmor restriction.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || true)" = 1 ]; then
    home=$(getent passwd "$username" | cut -d: -f6)
    profile=/etc/apparmor.d/happier-docker-rootless
    printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\n"%s/bin/rootlesskit" flags=(unconfined) {\\n  userns,\\n}\\n' "$home" > "$profile"
    apparmor_parser -r "$profile"
fi
exec runuser -u "$username" -- sh -s <<'HAPPIER_ROOTLESS_USER'
set -eu
test "$(id -u)" -ne 0
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
unset DOCKER_HOST DOCKER_CONTEXT
export PATH="$HOME/bin:/usr/share/docker.io/contrib:$PATH"
tool=$(command -v dockerd-rootless-setuptool.sh || true)
rootless=$(command -v dockerd-rootless.sh || true)
# The upstream setup tool invokes Docker beside dockerd-rootless.sh. Some
# distro packages put the scripts in contrib but keep Docker in /usr/bin.
if [ -n "$tool" ] && [ -n "$rootless" ] && [ -x "$(dirname "$rootless")/docker" ]; then
    "$tool" install --force
else
    # Ubuntu's docker.io can omit or split the upstream rootless tools. Use Docker's
    # documented user install, without replacing packages or the shared daemon.
    installer=$(mktemp)
    trap 'rm -f "$installer"' EXIT HUP INT TERM
    curl -fsSL https://get.docker.com/rootless -o "$installer"
    FORCE_ROOTLESS_INSTALL=1 sh "$installer"
fi
# Both official installers check subordinate IDs and kernel prerequisites.
systemctl --user enable --now docker.service
docker context use rootless
docker --context rootless info >/dev/null
HAPPIER_ROOTLESS_USER
`;

export function createDockerRootlessSteps<T extends string | { kind: 'targetFact'; fact: 'daemon.username' }>(username: T) {
    // Preserve the concrete-step type for native callers and bind only recipe declarations.
    const lingerPath = (typeof username === 'string' ? `/var/lib/systemd/linger/${username}`
        : { kind: 'template', value: '/var/lib/systemd/linger/{username}', variables: { username } }) as
        T extends string ? string : { kind: 'template'; value: string; variables: { username: T } };
    return [
        { id: 'docker-rootless-prerequisites', kind: 'package' as const, manager: 'apt',
            packages: ['uidmap', 'slirp4netns', 'rootlesskit', 'dbus-user-session', 'curl', 'ca-certificates', 'iptables', 'kmod', 'apparmor'].map(name => ({ name })) },
        { id: 'docker-rootless-launcher', kind: 'file' as const, path: launcher, owner: 'root', group: 'root', mode: 0o755,
            // Bind the shell body as a literal so its Go and AppArmor braces are preserved.
            content: typeof username === 'string'
                ? { kind: 'literal' as const, value: installTemplate.replace('{daemonUsername}', () => username) + installBody }
                : { kind: 'template' as const, value: `${installTemplate}{installBody}`, variables: { daemonUsername: username, installBody } } },
        { id: 'docker-rootless-linger', kind: 'command' as const, executable: 'loginctl', args: ['enable-linger', username],
            requiredFacts: [{ kind: 'init' as const, system: 'systemd' as const }],
            check: { executable: 'test', args: ['-f', lingerPath], unsatisfiedExitCodes: [1] } },
        { id: 'docker-rootless-install', kind: 'script' as const, shell: 'sh' as const, body: `${launcher}\n`,
            requiredFacts: [{ kind: 'init' as const, system: 'systemd' as const }],
            review: { title: 'Set up rootless Docker for Happier', description: 'Creates a user Docker service and selects its rootless context. Loads a user-specific AppArmor profile where required. Keeps the shared Docker daemon unchanged.' },
            check: { body: `test -x ${launcher} || exit 1\n${launcher} --check\n`, unsatisfiedExitCodes: [1] } },
    ];
}
