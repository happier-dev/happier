import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DeploymentTemplateV1Schema, DeploymentTemplateRefV1Schema, DeploymentEnvironmentContentV1Schema, type DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { prepareDeploymentTemplateInstantiationV1 } from './prepareDeploymentTemplateInstantiationV1.js';

const source = { services: { db: { image: 'postgres:17', environment: { POSTGRES_PASSWORD: '${DB_PASSWORD}' },
    volumes: ['data:/var/lib/postgresql/data'], healthcheck: { test: ['CMD', 'pg_isready'] } } }, volumes: { data: {} } };
const template = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'PostgreSQL',
    compose: { document: JSON.stringify(source), profiles: [], services: ['db'], primaryService: 'db' },
    variables: [{ key: 'DB_PASSWORD', label: 'Password', required: true, valueKind: 'string', secret: true,
        sites: [{ service: 'db', path: ['environment', 'POSTGRES_PASSWORD'] }] }], generatedSecrets: [], domains: [],
    volumes: [{ id: 'data', service: 'db', target: '/var/lib/postgresql/data', persistent: true, backup: true, consistency: 'logicalDump' }],
    data: { engine: 'postgres', service: 'db', port: 5432, variables: { password: 'DB_PASSWORD' }, logicalBackup: { adapter: 'postgres-v1' } },
    exports: { database: { service: 'db', port: 5432, defaultExposure: 'internal', env: {
        DATABASE_URL: 'postgres://app:${DB_PASSWORD}@db:5432/app', DIRECT_URL: 'postgres://app:${DB_PASSWORD}@db:5432/app' } } } });
const templateRef = DeploymentTemplateRefV1Schema.parse({ sourceId: 'data', itemId: 'postgres', version: '1',
    ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } });
const binding = createDeploymentSecretVariableBindingV1({ name: 'DB_PASSWORD', phase: 'runtime', resourceId: 'password', resourceRevision: 1 });
function current(environment: Record<string, unknown> = {}) {
    const source = { services: { app: { image: 'app:1', environment, depends_on: ['cache'] }, cache: { image: 'redis:7' } } };
    const content: DeploymentEnvironmentContentV1 = { name: 'Existing', retainPreviousDeployments: 1, bindings: [],
        definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}`, document: JSON.stringify(source),
            profiles: [], services: ['app', 'cache'], primaryService: 'app' } };
    return { content, source };
}

describe('stored template preparation', () => {
    it('carries exact public files and merges upgrades without replacing hand edits', () => {
        const publicFiles = [{ path: 'files/app.conf', content: 'upstream=1' }];
        const selected = DeploymentTemplateV1Schema.parse({ ...template, compose: { ...template.compose, publicFiles } });
        expect(prepareDeploymentTemplateInstantiationV1({ template: selected, templateRef, source, bindings: [binding] }).publicFiles).toEqual(publicFiles);
        const existing = current();
        existing.content.bindings = [binding];
        existing.content.template = { templateRef, services: ['db'], definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` } };
        if (existing.content.definition.kind !== 'stored') throw new Error('Expected stored source');
        existing.content.definition.publicFiles = [{ path: 'files/app.conf', content: 'local=1' }, { path: 'files/local.conf', content: 'keep' }];
        const nextRef = { ...templateRef, version: '2' };
        const input = { template: selected, templateRef: nextRef, source, bindings: [], current: { ...existing,
            source: { ...existing.source, services: { ...existing.source.services, ...source.services }, volumes: source.volumes },
            baseline: { templateRef, source, publicFiles } } };
        expect(prepareDeploymentTemplateInstantiationV1(input).publicFiles).toEqual(existing.content.definition.publicFiles);
        expect(() => prepareDeploymentTemplateInstantiationV1({ ...input, template: { ...selected, compose: { ...selected.compose,
            publicFiles: [{ path: 'files/app.conf', content: 'upstream=2' }] } } }))
            .toThrowError(expect.objectContaining({ code: 'template_resource_conflict' }));
        const specialFile = { path: '__proto__', content: 'a public file' };
        const addedFile = { path: 'files/new.conf', content: 'upstream addition' };
        expect(prepareDeploymentTemplateInstantiationV1({ ...input,
            template: { ...selected, compose: { ...selected.compose, publicFiles: [...publicFiles, specialFile, addedFile] } },
            current: { ...input.current,
                content: { ...existing.content, definition: { ...existing.content.definition,
                    publicFiles: [...existing.content.definition.publicFiles, specialFile] } },
                baseline: { ...input.current.baseline, publicFiles: [...publicFiles, specialFile] } },
        }).publicFiles).toEqual([...existing.content.definition.publicFiles.slice(0, 1), specialFile,
            ...existing.content.definition.publicFiles.slice(1), addedFile]);
    });
    it('rejects public files that overwrite the Compose source or collide within the contained tree', () => {
        for (const publicFiles of [[{ path: 'compose.yaml', content: 'replace' }], [{ path: 'Compose.yaml', content: 'replace' }],
            [{ path: 'compose.yaml.', content: 'replace' }], [{ path: 'compose.yaml ', content: 'replace' }],
            [{ path: 'C:outside', content: '' }], [{ path: '../outside', content: '' }],
            [{ path: 'files/a', content: '' }, { path: 'files/a', content: 'duplicate' }],
            [{ path: 'files/a', content: '' }, { path: 'files/a/b', content: 'child' }]]) {
            expect(DeploymentTemplateV1Schema.safeParse({ ...template, compose: { ...template.compose, publicFiles } }).success).toBe(false);
        }
    });
    it('validates the bundled PostgreSQL resource through the host template contract', async () => {
        const raw: unknown = JSON.parse(await readFile(new URL('../../../plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
        if (!raw || typeof raw !== 'object' || !('apps' in raw) || !Array.isArray(raw.apps)) throw new Error('Expected packaged app catalog');
        const selected: unknown = raw.apps.find((entry: unknown) => !!entry && typeof entry === 'object' && 'itemId' in entry && entry.itemId === 'postgresql');
        if (!selected || typeof selected !== 'object' || !('app' in selected)) throw new Error('Expected PostgreSQL catalog item');
        const app = DeploymentTemplateV1Schema.parse(selected.app);
        expect(app).toMatchObject({ data: { engine: 'postgres', service: 'database', port: 5432,
            logicalBackup: { adapter: 'postgres-v1', database: 'DB_NAME', username: 'DB_USER' } },
        exports: {
            DATABASE_URL: { service: 'database', port: 5432, defaultExposure: 'internal',
                env: { DATABASE_URL: 'postgres://${DB_USER}:${DB_PASSWORD}@database:5432/${DB_NAME}' } },
            DIRECT_URL: { service: 'database', port: 5432, defaultExposure: 'internal',
                env: { DIRECT_URL: 'postgres://${DB_USER}:${DB_PASSWORD}@database:5432/${DB_NAME}' } },
        },
        loginFields: { username: 'DB_USER', password: 'DB_PASSWORD' } });
        expect(app.variables.find(variable => variable.key === 'DB_PASSWORD')).toMatchObject({ secret: true });
        expect(app.variables.find(variable => variable.key === 'DB_PASSWORD')?.default).toBeUndefined();
        expect(app.generatedSecrets).toMatchObject([{ key: 'DB_PASSWORD', profile: { kind: 'base64url-32-bytes' } }]);
        expect(app.compose.document).not.toMatch(/\bports:/u);
    });

    it('reviews declared capacity shortfalls without refusing the attempt or inventing unavailable disk observations', () => {
        const declared = DeploymentTemplateV1Schema.parse({ ...template, minimumResources: { memoryBytes: 2048, freeDiskBytes: 4096 } });
        const input = { template: declared, templateRef, source, bindings: [binding] };
        const prepared = prepareDeploymentTemplateInstantiationV1({ ...input, targetResources: { sampledAt: 100, memoryBytes: 1024 } });
        expect(prepared).toMatchObject({ capacity: [
            { resource: 'memoryBytes', minimumBytes: 2048, observedBytes: 1024, observedAt: 100, state: 'shortfall' },
            { resource: 'freeDiskBytes', minimumBytes: 4096, observedBytes: null, observedAt: null, state: 'unknown' },
        ] });
        expect(prepared.document).toBe(JSON.stringify(source));
        expect(prepareDeploymentTemplateInstantiationV1({ ...input, targetResources: { sampledAt: 200, memoryBytes: 2048 } }))
            .toMatchObject({ capacity: [{ resource: 'memoryBytes', observedBytes: 2048, state: 'meetsMinimum' },
                { resource: 'freeDiskBytes', state: 'unknown' }] });
        expect(prepareDeploymentTemplateInstantiationV1({ ...input, targetResources: { sampledAt: 200, memoryBytes: 0 } }))
            .toMatchObject({ capacity: [{ resource: 'memoryBytes', observedBytes: 0, state: 'shortfall' },
                { resource: 'freeDiskBytes', state: 'unknown' }] });
        expect(prepareDeploymentTemplateInstantiationV1(input)).toMatchObject({ capacity: [
            { resource: 'memoryBytes', observedBytes: null, state: 'unknown' }, { resource: 'freeDiskBytes', state: 'unknown' },
        ] });
    });
    it('connects through uninterpolated exports and retains existing services, health, volumes and the exact secret ref', () => {
        const participation = [{ service: 'db', participates: false }];
        const input = { template: { ...template, health: participation }, templateRef, source, current: current(), bindings: [binding], connectTo: { service: 'app' } };
        const before = structuredClone(input);
        const prepared = prepareDeploymentTemplateInstantiationV1(input);
        const compose = JSON.parse(prepared.document);
        expect(compose.services).toHaveProperty('app');
        expect(compose.services.app.environment).toEqual(template.exports?.database?.env);
        expect(compose.services.app.depends_on).toEqual(['cache', 'db']);
        expect(compose.services.db).toEqual(source.services.db);
        expect(compose.services.cache).toEqual({ image: 'redis:7' });
        expect(compose.volumes).toEqual(source.volumes);
        expect(prepared.bindings).toEqual([binding]);
        expect(prepared.template).toMatchObject({ templateRef, data: template.data, exports: template.exports, services: ['db'], health: participation });
        const stored = DeploymentEnvironmentContentV1Schema.parse({ ...input.current.content,
            template: { ...prepared.template, definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` } } });
        expect(stored.template?.health).toEqual(participation);
        expect(prepared.primaryService).toBe('app');
        expect(prepareDeploymentTemplateInstantiationV1(input)).toEqual(prepared);
        expect(input).toEqual(before);
    });

    it('requires independent explicit Replace choices for both existing connection keys', () => {
        const input = { template, templateRef, source, current: current({ DATABASE_URL: 'hand-set', DIRECT_URL: 'hand-set-direct' }),
            bindings: [binding], connectTo: { service: 'app' } };
        for (const replace of [[], ['DATABASE_URL']]) expect(() => prepareDeploymentTemplateInstantiationV1({ ...input, replace }))
            .toThrowError(expect.objectContaining({ code: 'template_binding_conflict' }));
        const prepared = prepareDeploymentTemplateInstantiationV1({ ...input, replace: ['DATABASE_URL', 'DIRECT_URL'] });
        expect(JSON.parse(prepared.document).services.app.environment).toEqual(template.exports?.database?.env);
    });

    it('prepares the same repository-owned source for the existing PR writer without replacing its owner', () => {
        const existing = current();
        const repository = { ...existing, content: { ...existing.content, definition: { kind: 'repository' as const, ref: 'main',
            compose: { path: 'compose.yaml', profiles: ['prod'], services: ['app'], primaryService: 'app' } } } };
        const prepared = prepareDeploymentTemplateInstantiationV1({ template, templateRef, source, current: repository,
            bindings: [binding], connectTo: { service: 'app' } });
        expect(prepared.profiles).toEqual(['prod']);
        expect(prepared.services).toEqual(['app', 'db']);
        expect(prepared.primaryService).toBe('app');
        expect(JSON.parse(prepared.document).services.app.environment).toEqual(template.exports?.database?.env);
        expect(repository.content.definition).toMatchObject({ kind: 'repository', ref: 'main' });
    });

    it('rejects missing refs, literal secret values, and an undeclared generator', () => {
        const input = { template, templateRef, source };
        expect(() => prepareDeploymentTemplateInstantiationV1({ ...input, bindings: [] })).toThrowError(expect.objectContaining({ code: 'template_variable_required' }));
        expect(() => prepareDeploymentTemplateInstantiationV1({ ...input, bindings: [{ ...binding, source: { kind: 'value', value: 'plaintext' } }] }))
            .toThrowError(expect.objectContaining({ code: 'template_secret_reference_required' }));
        expect(() => prepareDeploymentTemplateInstantiationV1({ ...input, bindings: [{ ...binding, source: { kind: 'generated', key: 'DB_PASSWORD' } }] }))
            .toThrowError(expect.objectContaining({ code: 'template_generator_undeclared', details: { key: 'DB_PASSWORD' } }));
    });

    it('leaves per-site fallbacks unbound unless the person supplies a value, and refuses a required neighbor', () => {
        const perSite = { ...source, services: { db: { ...source.services.db, environment: {
            ...source.services.db.environment, FIRST: '${X:-alpha}', SECOND: '${X:-beta}',
        } } } };
        const optional = DeploymentTemplateV1Schema.parse({ ...template, variables: [...template.variables,
            { key: 'X', label: 'X', required: false, secret: false, valueKind: 'string', sites: [
                { service: 'db', path: ['environment', 'FIRST'] }, { service: 'db', path: ['environment', 'SECOND'] },
            ] }] });
        const input = { template: optional, templateRef, source: perSite, bindings: [binding] };
        const omitted = prepareDeploymentTemplateInstantiationV1(input);
        expect(omitted.bindings).toEqual([binding]);
        expect(JSON.parse(omitted.document).services.db.environment).toEqual(perSite.services.db.environment);
        const explicit = { purpose: 'variable' as const, name: 'X', phase: 'runtime' as const,
            source: { kind: 'value' as const, value: 'chosen' } };
        expect(prepareDeploymentTemplateInstantiationV1({ ...input, bindings: [binding, explicit] }).bindings).toEqual([binding, explicit]);
        const required = { ...optional, variables: optional.variables.map(variable => variable.key === 'X' ? { ...variable, required: true } : variable) };
        expect(() => prepareDeploymentTemplateInstantiationV1({ ...input, template: required })).toThrowError(
            expect.objectContaining({ code: 'template_variable_required' }));
    });

    it('previews the exact declared generation profile without generating bytes or a new ref', () => {
        const generated = DeploymentTemplateV1Schema.parse({ ...template,
            generatedSecrets: [{ key: 'DB_PASSWORD', purpose: 'database-password', label: 'Password', profile: { kind: 'base64url-32-bytes' } }] });
        const prepared = prepareDeploymentTemplateInstantiationV1({ template: generated, templateRef, source,
            bindings: [{ ...binding, source: { kind: 'generated', key: 'DB_PASSWORD' } }] });
        expect(prepared.generatedSecrets).toEqual([{ name: 'DB_PASSWORD', phase: 'runtime', key: 'DB_PASSWORD', profile: { kind: 'base64url-32-bytes' } }]);
        expect(prepared.bindings).toEqual([]);
        expect(prepared.document).toBe(JSON.stringify(source));
    });

    it.each(['db.example.test', 'qa-domain.localhost', 'xn--bcher-kva.example'])('derives domain host and URL values from admitted DNS hostname %s', hostname => {
        const withDomain = DeploymentTemplateV1Schema.parse({ ...template,
            domains: [{ key: 'console', service: 'db', containerPort: 8080, protocol: 'https', required: true, path: '/console' }],
            variables: [...template.variables, ...(['domainHost', 'domainUrl'] as const).map(kind => ({
                key: kind, label: kind, required: true, valueKind: 'string', secret: false,
                valueFrom: { kind, domainKey: 'console' }, sites: [{ service: 'db', path: ['environment', kind] }],
            }))] });
        const prepared = prepareDeploymentTemplateInstantiationV1({ template: withDomain, templateRef, source,
            bindings: [binding], domainBindings: [{ templateDomainId: 'console', hostname }] });
        expect(prepared.bindings.find(binding => binding.name === 'domainHost')?.source)
            .toEqual({ kind: 'value', value: hostname });
        expect(prepared.bindings.find(binding => binding.name === 'domainUrl')?.source)
            .toEqual({ kind: 'value', value: `https://${hostname}/console` });
    });

    it.each(['x{env.X}.com', 'x{env.x}.com', 'x\".com', "x'.com", 'x`.com', 'x$.com', 'x_.com', '-x.com', 'x-.com', 'x..com', 'bücher.example', 'x.com\n'])('refuses non-DNS template hostname %s with the existing typed reason', hostname => {
        const withDomain = DeploymentTemplateV1Schema.parse({ ...template,
            domains: [{ key: 'console', service: 'db', containerPort: 8080, protocol: 'https', required: true, path: '/console' }] });
        expect(() => prepareDeploymentTemplateInstantiationV1({ template: withDomain, templateRef, source,
            bindings: [binding], domainBindings: [{ templateDomainId: 'console', hostname }] }))
            .toThrowError(expect.objectContaining({ code: 'template_needs_review' }));
    });

    it('requires Replace before planning a generated replacement of an existing credential', () => {
        const generated = DeploymentTemplateV1Schema.parse({ ...template,
            generatedSecrets: [{ key: 'DB_PASSWORD', purpose: 'database-password', label: 'Password', profile: { kind: 'base64url-32-bytes' } }] });
        const existing = current();
        existing.content.bindings = [binding];
        const input = { template: generated, templateRef, source, current: existing,
            bindings: [{ ...binding, source: { kind: 'generated' as const, key: 'DB_PASSWORD' } }] };
        expect(() => prepareDeploymentTemplateInstantiationV1(input))
            .toThrowError(expect.objectContaining({ code: 'template_binding_conflict' }));
        expect(prepareDeploymentTemplateInstantiationV1({ ...input, replace: ['DB_PASSWORD'] }).generatedSecrets)
            .toEqual([{ name: 'DB_PASSWORD', phase: 'runtime', key: 'DB_PASSWORD', profile: { kind: 'base64url-32-bytes' } }]);
    });

    it('reviews a newer pinned catalog occurrence while preserving hand edits and the existing secret ref', () => {
        const existing = current();
        existing.content.bindings = [binding];
        existing.content.template = { templateRef, services: ['db'], definition: {
            kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}`,
        } };
        const selectedRef = DeploymentTemplateRefV1Schema.parse({ ...templateRef, version: '2',
            ref: { kind: 'content', digest: `sha256:${'c'.repeat(64)}` } });
        const { healthcheck: _oldHealthcheck, ...nextService } = source.services.db;
        const next = { ...source, services: { db: { ...nextService, image: 'postgres:18' } } };
        const input = { template, templateRef: selectedRef, source: next, bindings: [], current: { ...existing,
            source: { services: { ...existing.source.services, db: { ...source.services.db,
                environment: { ...source.services.db.environment, TZ: 'Europe/Amsterdam' } } }, volumes: source.volumes },
            baseline: { templateRef, source },
        } };
        const before = structuredClone(input);
        const prepared = prepareDeploymentTemplateInstantiationV1(input);
        const { healthcheck: _removedHealthcheck, ...localService } = input.current.source.services.db;
        expect(JSON.parse(prepared.document).services).toEqual({ ...input.current.source.services,
            db: { ...localService, image: 'postgres:18' } });
        expect(prepared.bindings).toEqual([binding]);
        expect(prepared.generatedSecrets).toEqual([]);
        expect(prepared.template.templateRef).toEqual(selectedRef);
        expect(input).toEqual(before);
        expect(() => prepareDeploymentTemplateInstantiationV1({ ...input, current: { ...input.current,
            source: { ...input.current.source, services: { ...input.current.source.services,
                db: { ...input.current.source.services.db, image: 'hand-edited:1' } } },
        } })).toThrowError(expect.objectContaining({ code: 'template_service_conflict' }));
        expect(() => prepareDeploymentTemplateInstantiationV1({ ...input, current: { ...input.current,
            baseline: { templateRef: selectedRef, source },
        } })).toThrowError(expect.objectContaining({ code: 'template_changed' }));
        expect(() => prepareDeploymentTemplateInstantiationV1({ ...input, current: { ...input.current,
            baseline: undefined,
        } })).toThrowError(expect.objectContaining({ code: 'template_source_unavailable' }));
    });

    it('refuses missing descriptor services and existing service collisions instead of overriding either definition', () => {
        expect(() => prepareDeploymentTemplateInstantiationV1({ template, templateRef, source: { services: {} }, bindings: [binding] }))
            .toThrowError(expect.objectContaining({ code: 'template_needs_review' }));
        for (const foreign of [
            { ...template, compose: { ...template.compose, primaryService: 'missing' } },
            { ...template, health: [{ service: 'missing', participates: true }] },
        ]) expect(() => prepareDeploymentTemplateInstantiationV1({ template: foreign, templateRef, source, bindings: [binding] }))
            .toThrowError(expect.objectContaining({ code: 'template_needs_review' }));
        const existing = current();
        const colliding = { ...existing, source: { services: { ...existing.source.services, db: { image: 'foreign:1' } } } };
        expect(() => prepareDeploymentTemplateInstantiationV1({ template, templateRef, source, current: colliding, bindings: [binding] }))
            .toThrowError(expect.objectContaining({ code: 'template_service_conflict' }));
    });
});
