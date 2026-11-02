import { describe, expect, it } from 'vitest';
import * as owner from './resticExecutor.js';
import { RESTIC_RUNTIME_V1, type ResticCommandV1 } from './resticExecutor.js';
const buildResticRequestV1 = (...args: unknown[]) => {
    const implementation = Reflect.get(owner, 'buildResticRequestV1');
    expect(implementation, 'buildResticRequestV1 is the required owner behavior').toBeTypeOf('function');
    return implementation(...args);
};

const access = { repository: 's3:https://s3.example.test/bucket/env', passwordFilePath: '/run/secrets/repository-password',
    credentialFiles: [{ hostPath: '/run/owned/repository-password', containerPath: '/run/secrets/repository-password', readOnly: true }] as const,
    environmentVariableNames: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const,
    s3: { region: 'eu-west-1', addressing: 'path' as const } };
const request = (command: ResticCommandV1) => buildResticRequestV1({ access, environmentId: 'env-one', command });

describe('restic request contract', () => {
    it('uses one digest pin and stable host/source tags with protected-file credentials for a dump', () => {
        const dump = request({ kind: 'backupStdin', sourceId: 'postgres-main', filename: 'db.dump' });
        expect(dump.runtime).toBe(RESTIC_RUNTIME_V1);
        expect(dump.argv).toEqual(['--repo', access.repository, '--json', '-o', 's3.region=eu-west-1', '-o', 's3.bucket-lookup=path',
            'backup', '--host', 'happier-env-env-one', '--tag', 'happier', '--tag', 'env:env-one', '--tag', 'kind:dump',
            '--tag', 'src:postgres-main', '--stdin', '--stdin-filename', 'db.dump']);
        expect(dump.passwordFilePath).toBe(access.passwordFilePath);
        expect(dump.environmentVariableNames).toEqual(access.environmentVariableNames);
        expect(dump.credentialFiles).toEqual(access.credentialFiles);
        expect(JSON.stringify(dump)).not.toContain('RESTIC_PASSWORD=');
    });

    it('uses a single AND ownership selector and explicit grouping/retention independent of container paths', () => {
        const forget = request({ kind: 'forget', retention: { kind: 'keep', last: 2, daily: 7 }, dryRun: true });
        expect(forget.argv.slice(7)).toEqual(['forget', '--host', 'happier-env-env-one', '--tag', 'happier,env:env-one',
            '--group-by', 'host,tags', '--keep-last', '2', '--keep-daily', '7', '--dry-run']);
        expect(request({ kind: 'backupPaths', sourceId: 'data', paths: ['/source/data'] }).argv.slice(-3)).toEqual(['src:data', '--', '/source/data']);
        expect(request({ kind: 'snapshots', snapshotId: 'a'.repeat(64) }).argv.slice(-1)).toEqual(['a'.repeat(64)]);
    });

    it('builds format-v2 init, native metadata/integrity and restore-read requests through the same pin', () => {
        const cases: readonly ResticCommandV1[] = [{ kind: 'init' }, { kind: 'config' }, { kind: 'check' },
            { kind: 'tree', treeId: 'b'.repeat(64) }, { kind: 'dump', snapshotId: 'a'.repeat(64), path: '/db.dump' }, { kind: 'prune' }];
        expect(cases.map(command => request(command).runtime)).toEqual(cases.map(() => RESTIC_RUNTIME_V1));
        expect(request({ kind: 'init' }).argv.slice(-3)).toEqual(['init', '--repository-version', '2']);
        expect(request({ kind: 'config' }).argv.slice(-2)).toEqual(['cat', 'config']);
        expect(request({ kind: 'tree', treeId: 'b'.repeat(64) }).argv.slice(-3)).toEqual(['cat', 'tree', 'b'.repeat(64)]);
        expect(request({ kind: 'dump', snapshotId: 'a'.repeat(64), path: '/db.dump' }).argv).not.toContain('--json');
    });

    it('rejects ambiguous snapshot aliases and ownership delimiters before a native request exists', () => {
        expect(() => request({ kind: 'dump', snapshotId: 'latest', path: '/db.dump' })).toThrow();
        expect(() => buildResticRequestV1({ access, environmentId: 'one,two', command: { kind: 'init' } })).toThrow();
        expect(() => request({ kind: 'backupStdin', sourceId: 'one,two', filename: 'db.dump' })).toThrow();
        expect(() => request({ kind: 'forget', retention: { kind: 'keepEverything' }, dryRun: true })).toThrow();
    });
});
