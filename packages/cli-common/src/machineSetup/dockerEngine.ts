import type { MachineRecipeStepV1 } from './index.js';

export type DockerEngineSetupFacts = Readonly<{ distribution: 'ubuntu' | 'debian'; codename: string; architecture: string; daemonUsername: 'happier' }>;
export function createDockerEngineSetupSteps(input: DockerEngineSetupFacts): MachineRecipeStepV1[] {
    return [
        { id: 'docker-source-prerequisites', kind: 'package', manager: 'apt', packages: [{ name: 'ca-certificates' }, { name: 'gnupg' }, { name: 'curl' }] },
        { id: 'docker-keyrings-directory', kind: 'directory', path: '/etc/apt/keyrings', owner: 'root', group: 'root', mode: 0o755 },
        { id: 'docker-source', kind: 'packageSource', manager: 'apt', path: '/etc/apt/sources.list.d/docker.sources',
            keyPath: '/etc/apt/keyrings/docker.asc', url: `https://download.docker.com/linux/${input.distribution}`,
            suite: input.codename, architectures: [input.architecture], components: ['stable'],
            keyUrl: `https://download.docker.com/linux/${input.distribution}/gpg`, keyFingerprint: '9DC858229FC7DD38854AE2D88D81803C0EBFCD88' },
        { id: 'docker-packages', kind: 'package', manager: 'apt', packages: ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin'].map(name => ({ name })) },
        { id: 'docker-membership', kind: 'group', name: 'docker', members: [input.daemonUsername] },
        { id: 'docker-service', kind: 'serviceUnit', unit: 'docker.service', enabled: true, running: true },
    ];
}
