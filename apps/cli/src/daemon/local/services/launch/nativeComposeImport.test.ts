import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { captureNativeComposeDefinition } from './nativeComposeImport';

describe('native Compose adoption source', () => {
    it('retains native data coordinates and inventories values without disclosing candidates', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-compose-import-'));
        const source = { projectName: 'existing', engineId: 'engine', workingDirectory: root,
            configFiles: [join(root, 'compose.json')], containerIds: ['a'.repeat(64)] };
        const model = { name: 'existing', services: { web: { image: 'app:1',
            command: 'connect https://${USER}:${PASSWORD:-default-private}@example/${OPTIONAL}/${EMPTY:-}',
            environment: { LITERAL: 'literal-private', INHERITED: null, EXPLICIT: '${PASSWORD:?private error}', EMPTY_VALUE: '${ENV_EMPTY:-}' },
            env_file: [{ path: join(root, 'private.env') }], volumes: [{ type: 'bind', source: root, target: '/data' }] } },
            configs: { public: { content: 'nonsecret configuration' }, fromEnvironment: { environment: 'CONFIG_INPUT', content: 'config-private' } },
            secrets: { fromEnvironment: { environment: 'SECRET_INPUT', 'x-#value': 'secret-private' } }, volumes: { data: { name: 'existing_data' } } };
        const variables = { USER: { Name: 'USER', Required: false, DefaultValue: '', PresenceValue: '' },
            PASSWORD: { Name: 'PASSWORD', Required: true, DefaultValue: 'default-private', PresenceValue: '' },
            OPTIONAL: { Name: 'OPTIONAL', Required: false, DefaultValue: '', PresenceValue: '' },
            ENV_EMPTY: { Name: 'ENV_EMPTY', Required: false, DefaultValue: '', PresenceValue: '' },
            EMPTY: { Name: 'EMPTY', Required: false, DefaultValue: '', PresenceValue: '' } };
        const boundary = join(root, 'docker.cjs');
        const original = structuredClone(model);
        delete (original.configs.fromEnvironment as { content?: string }).content;
        delete (original.secrets.fromEnvironment as { 'x-#value'?: string })['x-#value'];
        await writeFile(source.configFiles[0]!, JSON.stringify(original));
        await writeFile(boundary, `const args=process.argv.slice(2);if(!args.includes('config'))process.exit(20);if(process.env.COMPOSE_PROFILES!=='')process.exit(22);if(!args.includes('--variables')&&!args.includes('--no-env-resolution')){if(!args.includes('-'))process.exit(23);const projection=require('node:fs').readFileSync(0,'utf8');if(/default-private|literal-private|PASSWORD|config-private|secret-private/.test(projection))process.exit(24);}process.stdout.write(JSON.stringify(args.includes('--variables')?${JSON.stringify(variables)}:args.includes('--no-env-resolution')?${JSON.stringify(model)}:{services:{web:{environment:{LITERAL:'literal-private',INHERITED:null,EXPLICIT:'default-private',ODD_KEY:'envfile-private',UNSET_FILE:null}}}}));`);
        const exec = createStablePluginExecService({ signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath, args: [boundary] }), resolvePath: async () => root });
        try {
            const captured = await captureNativeComposeDefinition({ exec, source, profiles: [] });
            expect(captured.origin).toEqual({ projectName: 'existing', dockerEndpoint: 'engine', workingDirectory: root });
            expect(captured.variables).toEqual(expect.arrayContaining(['USER', 'PASSWORD', 'OPTIONAL', 'LITERAL', 'INHERITED', 'EXPLICIT', 'ODD_KEY']
                .map(name => expect.objectContaining({ name, phase: 'runtime' }))));
            expect(captured.variables.find(row => row.name === 'PASSWORD')).toMatchObject({ required: true, hasDefault: true });
            expect(captured.variables.find(row => row.name === 'EMPTY')).toMatchObject({ required: false, hasDefault: true });
            expect(captured.variables.find(row => row.name === 'ENV_EMPTY')).toMatchObject({ required: false, hasDefault: true });
            const value = JSON.parse(captured.document);
            expect(value.services.web).not.toHaveProperty('env_file');
            expect(value.services.web.environment).toEqual({ LITERAL: '${LITERAL:?required}', INHERITED: '${INHERITED}',
                EXPLICIT: '${EXPLICIT:?required}', EMPTY_VALUE: '${EMPTY_VALUE:?required}', ODD_KEY: '${ODD_KEY:?required}', UNSET_FILE: '${UNSET_FILE}' });
            expect(value.configs.public.content).toBe('nonsecret configuration');
            expect(value.configs.fromEnvironment).toEqual({ environment: 'CONFIG_INPUT' });
            expect(value.secrets.fromEnvironment).toEqual({ environment: 'SECRET_INPUT' });
            expect(captured.variables).toEqual(expect.arrayContaining(['CONFIG_INPUT', 'SECRET_INPUT'].map(name => expect.objectContaining({ name }))));
            expect(value.services.web.volumes[0].source).toBe(root);
            expect(JSON.stringify(captured)).not.toMatch(/default-private|literal-private|envfile-private|config-private|secret-private|private error/u);
            // Native merge may flatten these references out of its result.
            // Original-file admission must still use the stored-source owner.
            for (const unsupported of [
                { ...model, include: ['other.yaml'] },
                { ...model, services: { web: { ...model.services.web, build: '.' } } },
                { ...model, services: { web: { ...model.services.web, extends: { file: 'other.yaml', service: 'app' } } } },
                { ...model, configs: { settings: { file: './settings.json' } } },
            ]) {
                await writeFile(source.configFiles[0]!, JSON.stringify(unsupported));
                await expect(captureNativeComposeDefinition({ exec, source, profiles: [] })).rejects.toMatchObject({ code: 'needs_repository' });
            }
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
