import { expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { prepareDatabaseMoveCutoverPatch } from './databaseMoveCutover';

it.each([
    { variable: 'PGHOST', value: 'database' },
    { variable: 'CUSTOM_DSN', value: 'postgres://${USER}:${PASSWORD}@database:${PORT}/app' },
    { variable: 'DATABASE_URL', value: 'postgres://user:password@${DB_HOST}:5432/app' },
])('refuses removing a database still used by non-rewritable $variable', ({ variable, value }) => {
    const detail = createDeploymentEnvironmentDetailV1();
    const content = { ...detail.content, definition: { kind: 'stored' as const, contentRevision: 1,
        composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app', 'database'],
        document: JSON.stringify({ services: { database: { image: 'postgres:17' }, app: { image: 'app:1',
            environment: { DATABASE_URL: 'postgres://user:password@database:5432/app',
                DIRECT_URL: 'postgres://user:password@database:5432/app', [variable]: value } } } }) } };
    expect(prepareDatabaseMoveCutoverPatch(content, { sourceService: 'database', destinationEnvironmentId: 'moved',
        exportKey: 'database', username: 'app', database: 'app', password: { kind: 'secret',
            ref: formatSharedSavedSecretRefV1('password'), resourceRevision: 1 } },
    { kind: 'restored', verified: true, nextAction: 'review', evidence: {} }))
        .toEqual({ kind: 'unavailable', reason: 'non_machine_rewritable_dsn', variable });
});
