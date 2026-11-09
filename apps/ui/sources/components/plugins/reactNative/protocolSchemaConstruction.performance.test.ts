import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { countErrorAllocations } from '@/dev/testkit/performance/errorAllocations';
import { instantiatePluginUiCommonJsBundle } from './commonJsEvaluator';
import { compileUniversalPluginUiCommonJs } from '../../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../../../../packages/cli-common/sourceRuntimeEntries.mjs';

const root = resolve(process.cwd(), '../..');
const packages = await readWorkspacePackages(root);
const projectRoot = resolve(root, 'packages/protocol');
// Compile the actual schema owner embedded in Account runtimes. Foreign
// structural schemas legitimately probe; this cost contract names owned fields.
const artifact = await compileUniversalPluginUiCommonJs({
    projectRoot, entryPath: resolve(projectRoot, 'src/plugins/actions/protocolComposableSchema.ts'),
    artifactId: 'schema-construction', requestedExports: ['defineProtocolObject', 'defineProtocolString'], exportConditions: ['happier-source'],
    resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
        ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
});

it('constructs owned Account schema fields without expected validation failures and still parses consumed values', () => {
    const measured = countErrorAllocations('Protocol schema validation failed', () => {
        const module = instantiatePluginUiCommonJsBundle({ bytes: artifact.bytes,
            identity: { pluginId: 'schema-owner', artifactId: artifact.artifactId, digest: 'source-fixture' },
            requestedExport: 'defineProtocolObject' });
        const defineObject = module.readExport('defineProtocolObject') as typeof import('@happier-dev/protocol/plugins/actions/protocol-composable-schema').defineProtocolObject;
        const defineString = module.readExport('defineProtocolString') as typeof import('@happier-dev/protocol/plugins/actions/protocol-composable-schema').defineProtocolString;
        const field = defineString();
        const fields = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, field]));
        const schema = defineObject({ ...fields, nullable: field.nullable(), optional: field.optional() }, { policy: 'closed' });
        const value = { ...Object.fromEntries(Object.keys(fields).map(key => [key, key])), nullable: null };
        return { schema, value, parsed: schema.parse(value) };
    });
    expect(measured.count).toBe(0);
    const { schema, value, parsed } = measured.result;
    expect(parsed).toEqual(value);
    expect(schema.parse({ ...value, optional: 'present' })).toEqual({ ...value, optional: 'present' });
    expect(schema.safeParse({ nullable: null }).success).toBe(false);
    expect(schema.safeParse({ ...value, nullable: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...value, extra: true }).success).toBe(false);
});

it('keeps the real optionality fallback for a separately evaluated Protocol copy', () => {
    const measured = countErrorAllocations('Protocol schema validation failed', () => {
        const load = (pluginId: string) => instantiatePluginUiCommonJsBundle({
            bytes: artifact.bytes,
            identity: { pluginId, artifactId: artifact.artifactId, digest: 'source-fixture' },
            requestedExport: 'defineProtocolObject',
        });
        const defineObject = load('host').readExport('defineProtocolObject') as typeof import('@happier-dev/protocol/plugins/actions/protocol-composable-schema').defineProtocolObject;
        const defineString = load('foreign').readExport('defineProtocolString') as typeof import('@happier-dev/protocol/plugins/actions/protocol-composable-schema').defineProtocolString;
        const field = defineString();
        return defineObject({ required: field, optional: field.optional() }, { policy: 'closed' });
    });
    expect(measured.count).toBe(1);
    expect(measured.result.jsonSchema.required).toEqual(['required']);
    expect(measured.result.parse({ required: 'present', optional: 'also present' })).toEqual({ required: 'present', optional: 'also present' });
    expect(measured.result.safeParse({}).success).toBe(false);
});
