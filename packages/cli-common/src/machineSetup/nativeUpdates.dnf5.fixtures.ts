// Captured 2026-11-12 from docker.io/library/fedora:41, immutable image digest:
// sha256:f1a3fab47bcb3c3ddf3135d5ee7ba8b7b25f2e809a47440936212a3a50957f3d
// Upstream image source: https://github.com/fedora-cloud/docker-brew-fedora
// Each entry retains the executed argv and raw process result (LC_ALL=C).
// Capture: docker run --rm --network=none -e LC_ALL=C <image@digest> <argv>.
// Package rows are real --installed output, reused as constructed upgrade/security
// selections to test decoding without depending on changing repository advisories.
// Empty upgrade selections, version, architecture and reboot outputs are unmodified.
export const dnf5Fixtures = {
    "version": {
        "command": [
            "dnf",
            "--version"
        ],
        "result": {
            "code": 0,
            "stdout": "dnf5 version 5.2.17.0\ndnf5 plugin API version 2.0\nlibdnf5 version 5.2.17.0\nlibdnf5 plugin API version 2.2\n\nLoaded dnf5 plugins:\n  name: builddep\n  version: 1.0.0\n  API version: 2.0\n\n  name: changelog\n  version: 1.0.0\n  API version: 2.0\n\n  name: config-manager\n  version: 0.1.0\n  API version: 2.0\n\n  name: copr\n  version: 0.1.0\n  API version: 2.0\n\n  name: needs_restarting\n  version: 1.0.0\n  API version: 2.0\n\n  name: repoclosure\n  version: 1.0.0\n  API version: 2.0\n\n  name: repomanage\n  version: 1.0.0\n  API version: 2.0\n\n  name: reposync\n  version: 1.0.0\n  API version: 2.0\n",
            "stderr": ""
        }
    },
    "architecture": {
        "command": [
            "rpm",
            "--eval",
            "%{_arch}"
        ],
        "result": {
            "code": 0,
            "stdout": "x86_64\n",
            "stderr": ""
        }
    },
    "packages": {
        "command": [
            "dnf",
            "--quiet",
            "--disablerepo=*",
            "repoquery",
            "--installed",
            "--queryformat",
            "%{name}\t%{epoch}:%{version}-%{release}\t%{arch}\n",
            "bash",
            "fedora-release-common"
        ],
        "result": {
            "code": 0,
            "stdout": "bash\t0:5.2.32-1.fc41\tx86_64\nfedora-release-common\t0:41-33\tnoarch\n",
            "stderr": ""
        }
    },
    "emptyAll": {
        "command": [
            "dnf",
            "--quiet",
            "--disablerepo=*",
            "repoquery",
            "--upgrades",
            "--latest-limit=1",
            "--queryformat",
            "%{name}\t%{epoch}:%{version}-%{release}\t%{arch}\n"
        ],
        "result": {
            "code": 0,
            "stdout": "",
            "stderr": ""
        }
    },
    "rebootFailure": {
        "command": [
            "dnf",
            "--quiet",
            "needs-restarting"
        ],
        "result": {
            "code": 1,
            "stdout": "",
            "stderr": "Failed to download metadata (metalink: \"https://mirrors.fedoraproject.org/metalink?repo=updates-released-f41&arch=x86_64\") for repository \"updates\": Cannot prepare internal mirrorlist: Curl error (6): Could not resolve hostname for https://mirrors.fedoraproject.org/metalink?repo=updates-released-f41&arch=x86_64 [Could not resolve host: mirrors.fedoraproject.org]\n"
        }
    },
    "reboot": {
        "command": [
            "dnf",
            "--quiet",
            "--disablerepo=*",
            "needs-restarting"
        ],
        "result": {
            "code": 0,
            "stdout": "No core libraries or services have been updated since boot-up.\nReboot should not be necessary.\n",
            "stderr": ""
        }
    },
    "packagesWithoutNewline": {
        "command": [
            "dnf",
            "--quiet",
            "--disablerepo=*",
            "repoquery",
            "--installed",
            "--queryformat",
            "%{name}\t%{epoch}:%{version}-%{release}\t%{arch}",
            "bash",
            "fedora-release-common"
        ],
        "result": {
            "code": 0,
            "stdout": "bash\t0:5.2.32-1.fc41\tx86_64fedora-release-common\t0:41-33\tnoarch",
            "stderr": ""
        }
    },
    "emptySecurity": {
        "command": [
            "dnf",
            "--quiet",
            "--disablerepo=*",
            "repoquery",
            "--upgrades",
            "--latest-limit=1",
            "--security",
            "--queryformat",
            "%{name}\t%{epoch}:%{version}-%{release}\t%{arch}\n"
        ],
        "result": {
            "code": 0,
            "stdout": "",
            "stderr": "No advisory found matching the specified filters.\n"
        }
    },
    "securityPackage": {
        "command": [
            "dnf",
            "--quiet",
            "--disablerepo=*",
            "repoquery",
            "--installed",
            "--queryformat",
            "%{name}\t%{epoch}:%{version}-%{release}\t%{arch}\n",
            "bash"
        ],
        "result": {
            "code": 0,
            "stdout": "bash\t0:5.2.32-1.fc41\tx86_64\n",
            "stderr": ""
        }
    }
} as const;
