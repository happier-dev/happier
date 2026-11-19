import { expect, it } from 'vitest';
import { isMap, parse, parseDocument } from 'yaml';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { authorDatabaseMoveCutoverPatch } from './databaseMoveCutover';

it('authors the reviewed Connect patch for every consumer while retaining source volume data', () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const content = { ...detail.content, definition: { kind: 'stored' as const, contentRevision: 1,
        composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: ['app', 'database'],
        document: 'services:\n  app:\n    image: app:1\n    environment:\n      DATABASE_URL: postgres://${DB_USER}:${DB_PASSWORD}@database:5432/${DB_NAME}?sslmode=prefer\n      DIRECT_URL: postgresql://${DB_USER}:${DB_PASSWORD}@database:5432/${DB_NAME}\n    depends_on: [database, cache]\n  database:\n    image: postgres:17\n    volumes: [data:/var/lib/postgresql/data]\n  cache:\n    image: redis:7\nvolumes:\n  data: {}\n' } };
    const selection = { sourceService: 'database', destinationEnvironmentId: 'dedicated-db', exportKey: 'postgres',
        username: 'app', database: 'app', password: { kind: 'secret' as const,
            ref: formatSharedSavedSecretRefV1('password'), resourceRevision: 1 } };
    const ready = authorDatabaseMoveCutoverPatch(content, selection);
    expect(ready.kind).toBe('ready');
    if (ready.kind !== 'ready') throw new Error(ready.reason);
    const source = parse(ready.patch.definition.document);
    expect(source.services.database).toBeUndefined();
    expect(source.services.app.depends_on).toEqual(['cache']);
    expect(source.volumes).toEqual({ data: {} });
    expect(source.services.app.environment.DATABASE_URL)
        .toBe('postgres://app:${DB_MOVE_PASSWORD}@${DB_MOVE_HOST}:${DB_MOVE_PORT}/app?sslmode=prefer');
    expect(source.services.app.environment.DIRECT_URL)
        .toBe('postgresql://app:${DB_MOVE_PASSWORD}@${DB_MOVE_HOST}:${DB_MOVE_PORT}/app');
    expect(ready.patch.bindings.set).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'DB_MOVE_PASSWORD', source: selection.password }),
        expect.objectContaining({ name: 'DB_MOVE_HOST', source: { kind: 'reference', environmentId: 'dedicated-db',
            export: 'postgres', via: 'auto', component: 'host' } }),
        expect.objectContaining({ name: 'DB_MOVE_PORT', source: { kind: 'reference', environmentId: 'dedicated-db',
            export: 'postgres', via: 'auto', component: 'port' } }),
    ]));
    const multiple = parse(content.definition.document);
    multiple.services.worker = { image: 'worker:1',
        environment: ['DATABASE_URL=postgres://user:password@database:5432/app'],
        depends_on: { database: { condition: 'service_healthy' }, cache: { condition: 'service_started' } } };
    multiple.services.other = { image: 'other:1', environment: { DATABASE_URL: 'postgres://user:password@cache:5432/other' } };
    const allConsumers = authorDatabaseMoveCutoverPatch(
        { ...content, definition: { ...content.definition, document: JSON.stringify(multiple) } }, selection);
    expect(allConsumers.kind).toBe('ready');
    if (allConsumers.kind !== 'ready') throw new Error(allConsumers.reason);
    const allServices = parse(allConsumers.patch.definition.document).services;
    const reviewedDocument = parseDocument(allConsumers.patch.definition.document);
    expect(isMap(reviewedDocument.contents) && reviewedDocument.contents.flow !== true).toBe(true);
    expect(allConsumers.patch.definition.document).toContain('${DB_MOVE_PORT}');
    expect(allConsumers.patch.definition.document).not.toMatch(/\$\{[^}]*[\r\n]/u);
    expect(allServices.worker.environment).toEqual(['DATABASE_URL=postgres://app:${DB_MOVE_PASSWORD}@${DB_MOVE_HOST}:${DB_MOVE_PORT}/app']);
    expect(allServices.worker.depends_on).toEqual({ cache: { condition: 'service_started' } });
    expect(allServices.other.environment.DATABASE_URL).toBe('postgres://user:password@cache:5432/other');
    const opaque = { ...content, definition: { ...content.definition,
        document: 'services: {app: {image: "app:1", environment: {DATABASE_URL: "${OPAQUE}"}}, database: {image: "postgres:17"}}' } };
    expect(authorDatabaseMoveCutoverPatch(opaque, selection))
        .toEqual({ kind: 'unavailable', reason: 'non_machine_rewritable_dsn', variable: 'DATABASE_URL' });
});

it.each([
    { database: { image: 'postgres:17' } },
    { database: { image: 'postgres:17' }, app: { image: 'app:1',
        environment: { DATABASE_URL: 'postgres://user:password@other:5432/app' } } },
])('distinguishes no connected services from an opaque connection string', services => {
    const detail = createDeploymentEnvironmentDetailV1();
    const content = { ...detail.content, definition: { kind: 'stored' as const, contentRevision: 1,
        composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: Object.keys(services),
        document: JSON.stringify({ services }) } };
    expect(authorDatabaseMoveCutoverPatch(content, { sourceService: 'database', destinationEnvironmentId: 'moved',
        exportKey: 'database', username: 'app', database: 'app', password: { kind: 'secret',
            ref: formatSharedSavedSecretRefV1('password'), resourceRevision: 1 } }))
        .toEqual({ kind: 'unavailable', reason: 'no_connected_services' });
});

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
    expect(authorDatabaseMoveCutoverPatch(content, { sourceService: 'database', destinationEnvironmentId: 'moved',
        exportKey: 'database', username: 'app', database: 'app', password: { kind: 'secret',
            ref: formatSharedSavedSecretRefV1('password'), resourceRevision: 1 } }))
        .toEqual({ kind: 'unavailable', reason: 'non_machine_rewritable_dsn', variable });
});
