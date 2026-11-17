import { expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createDatabaseActions } from './actions.js';
import { DATABASE_ROWS_EXPORT_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { projectTargetActionApprovalInput } from '@happier-dev/protocol/actions/actionApprovalPresentation';

it('exports selected loaded cells through real Action admission, keeps exact values and marks partial evidence', async () => {
    const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', actions: createDatabaseActions({}) });
    const testkit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    const input = { format: 'csv', result: { columns: [
        { name: 'id', nativeType: 'bigint', semanticType: 'integer' }, { name: 'text', nativeType: 'text', semanticType: 'text' }],
        rows: [{ cells: [{ type: 'integer', value: '9007199254740993' }, { type: 'text', value: 'a,"b"\nc' }] },
            { cells: [{ type: 'null' }, { type: 'text', value: '' }] }], completeness: { complete: false, reason: 'page' } } };
    try {
        const result = await testkit.invokeAction(databaseActionLocalIdV1(DATABASE_ROWS_EXPORT_ACTION_ID_V1), input);
        expect(result).toMatchObject({ format: 'csv', rowCount: 2, completeness: { complete: false, reason: 'page' }, content: 'id,text\r\n9007199254740993,"a,""b""\nc"\r\n\\N,""' });
        const json = await testkit.invokeAction(databaseActionLocalIdV1(DATABASE_ROWS_EXPORT_ACTION_ID_V1), { ...input, format: 'json' });
        expect(json).toMatchObject({ format: 'json', content: expect.stringContaining('9007199254740993') });
        const action = plugin.manifest.contributes.actions!.find(action => action.id === databaseActionLocalIdV1(DATABASE_ROWS_EXPORT_ACTION_ID_V1))!;
        const observation = projectTargetActionApprovalInput(input, action.secretInputPaths);
        expect(observation?.input).toMatchObject({ result: { columns: input.result.columns, rows: [
            { cells: [{ type: 'integer', value: '[REDACTED]' }, { type: 'text', value: '[REDACTED]' }] },
            { cells: [{ type: 'null' }, { type: 'text', value: '[REDACTED]' }] }] } });
        expect(JSON.stringify(observation)).not.toContain('9007199254740993');
        await expect(testkit.invokeAction(databaseActionLocalIdV1(DATABASE_ROWS_EXPORT_ACTION_ID_V1), { ...input, result: { ...input.result, rows: [{ cells: [] }] } })).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
    } finally { await testkit.dispose(); }
});
