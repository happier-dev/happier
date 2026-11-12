import { buildResticSourceTagV1 } from './manifestV1.js';
import { buildResticRetentionArgsV1, type BackupRetentionV1 } from './retentionV1.js';

/** Stable snapshot path, independent of a service's mount target or operation. */
export const RESTIC_VOLUME_SOURCE_PATH_V1 = '/happier/source';
export const RESTIC_VOLUME_STAGE_PATH_V1 = '/happier/staging';

/** Published Docker Hub multi-platform index, checked 2026-10-28. */
export const RESTIC_RUNTIME_V1 = Object.freeze({
    version: '0.19.1', repositoryVersion: 2,
    image: 'restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510',
} as const);

/** Locator comes from the selected destination open; paths/names come from P42 custody. */
export type ResticAccessV1 = Readonly<{
    repository: string;
    passwordFilePath: string;
    credentialFiles: readonly Readonly<{ hostPath: string; containerPath: string; readOnly: true }>[];
    environmentVariableNames: readonly ('AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY' | 'AWS_SESSION_TOKEN')[];
    s3?: Readonly<{ region?: string; addressing?: 'auto' | 'dns' | 'path' }>;
    sftp?: Readonly<{ configFilePath: '/run/happier/backup/ssh-config' }>;
    local?: Readonly<{ path: string; mountPath?: string }>;
}>;
export type ResticCommandV1 =
    | Readonly<{ kind: 'init' | 'config' | 'prune' | 'check' }>
    | Readonly<{ kind: 'probe'; operationId: string; payload: Uint8Array }>
    | Readonly<{ kind: 'backupStdin'; sourceId: string; filename: string }>
    | Readonly<{ kind: 'backupPaths'; sourceId: string; paths: readonly [string, ...string[]] }>
    | Readonly<{ kind: 'snapshots'; latest?: number; snapshotId?: string }>
    | Readonly<{ kind: 'tree'; treeId: string }>
    | Readonly<{ kind: 'dump'; snapshotId: string; path: string }>
    | Readonly<{ kind: 'restoreVolume'; snapshotId: string }>
    | Readonly<{ kind: 'forget'; retention: BackupRetentionV1; dryRun: true }>
    | Readonly<{ kind: 'forgetExact'; snapshotIds: readonly [string, ...string[]] }>;
export type ResticRequestV1 = Readonly<{
    runtime: typeof RESTIC_RUNTIME_V1;
    /** Finite nonsecret destination probe; database streams use their existing producer. */
    stdin?: Uint8Array;
    argv: readonly string[];
    passwordFilePath: string;
    environmentVariableNames: ResticAccessV1['environmentVariableNames'];
    credentialFiles: ResticAccessV1['credentialFiles'];
    repositoryMount?: Readonly<{ hostPath: string; containerPath: '/run/happier/backup/repository'; repositoryHostPath?: string;
        /** Explicit init prepares the directory as the daemon, before the root helper creates repository files. */
        initialize?: true }>;
}>;

function ownershipId(value: string): string {
    // Restic interprets commas in --tag as an AND selector, not identifier bytes.
    if (!value || value.includes(',')) throw new RangeError('Invalid restic ownership identifier');
    return value;
}
function nativeId(value: string): string {
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new RangeError('An exact native restic identifier is required');
    return value;
}

/** Pure request construction. P30 alone owns admission, process IO and settlement. */
export function buildResticRequestV1(input: Readonly<{
    access: ResticAccessV1; environmentId: string; command: ResticCommandV1;
}>): ResticRequestV1 {
    const { access, command } = input;
    const environmentId = ownershipId(input.environmentId);
    const host = `happier-env-${environmentId}`;
    const environmentTag = `env:${environmentId}`;
    const selector = ['--host', host, '--tag', `happier,${environmentTag}`];
    const repositoryMount = access.local
        ? { hostPath: access.local.mountPath ?? access.local.path, containerPath: '/run/happier/backup/repository' as const,
            ...(access.local.mountPath !== undefined ? { repositoryHostPath: access.local.path } : {}),
            ...(command.kind === 'init' ? { initialize: true as const } : {}) } : undefined;
    const repository = access.local?.mountPath !== undefined ? access.repository : repositoryMount?.containerPath ?? access.repository;
    const argv = ['--repo', repository, ...(command.kind === 'dump' ? [] : ['--json'])];
    if (access.s3?.region !== undefined) argv.push('-o', `s3.region=${access.s3.region}`);
    if (access.s3?.addressing !== undefined) argv.push('-o', `s3.bucket-lookup=${access.s3.addressing}`);
    if (access.sftp) argv.push('-o', `sftp.command=ssh -F ${access.sftp.configFilePath} -s backup sftp`);
    switch (command.kind) {
        case 'init': argv.push('init', '--repository-version', String(RESTIC_RUNTIME_V1.repositoryVersion)); break;
        case 'config': argv.push('cat', 'config'); break;
        case 'prune': case 'check': argv.push(command.kind); break;
        case 'probe':
            argv.push('backup', '--host', `happier-probe-${ownershipId(command.operationId)}`,
                '--tag', 'happier-probe', '--stdin', '--stdin-filename', 'destination-probe');
            break;
        case 'backupStdin': case 'backupPaths': {
            const sourceTag = buildResticSourceTagV1(command.sourceId);
            argv.push('backup', '--host', host, '--tag', 'happier', '--tag', environmentTag,
                '--tag', command.kind === 'backupStdin' ? 'kind:dump' : 'kind:volume', '--tag', sourceTag);
            if (command.kind === 'backupStdin') argv.push('--stdin', '--stdin-filename', command.filename);
            else {
                if (!command.paths.length) throw new RangeError('A volume backup requires selected paths');
                argv.push('--', ...command.paths);
            }
            break;
        }
        case 'snapshots':
            if (command.latest !== undefined && (!Number.isSafeInteger(command.latest) || command.latest < 1 || command.snapshotId !== undefined)) {
                throw new RangeError('Invalid restic snapshot selection');
            }
            argv.push('snapshots', ...selector);
            if (command.latest !== undefined) argv.push('--latest', String(command.latest));
            if (command.snapshotId !== undefined) argv.push(nativeId(command.snapshotId));
            break;
        // cat tree takes a snapshot selector; cat blob loads this exact tree ID.
        case 'tree': argv.push('cat', 'blob', nativeId(command.treeId)); break;
        case 'dump': argv.push('dump', nativeId(command.snapshotId), command.path); break;
        case 'restoreVolume': argv.push('restore', `${nativeId(command.snapshotId)}:${RESTIC_VOLUME_SOURCE_PATH_V1}`,
            '--target', RESTIC_VOLUME_STAGE_PATH_V1, '--verify'); break;
        case 'forget': {
            const retention = buildResticRetentionArgsV1(command.retention);
            if (!retention.length) throw new RangeError('Keep everything has no forget request');
            argv.push('forget', ...selector, '--group-by', 'host,tags', ...retention, '--dry-run');
            break;
        }
        case 'forgetExact':
            if (!command.snapshotIds.length) throw new RangeError('Exact forget requires selected snapshots');
            argv.push('forget', ...command.snapshotIds.map(nativeId));
            break;
    }
    return { runtime: RESTIC_RUNTIME_V1, argv, ...(command.kind === 'probe' ? { stdin: command.payload } : {}), passwordFilePath: access.passwordFilePath,
        environmentVariableNames: [...access.environmentVariableNames], credentialFiles: access.credentialFiles.map(file => ({ ...file })),
        ...(repositoryMount ? { repositoryMount } : {}) };
}
