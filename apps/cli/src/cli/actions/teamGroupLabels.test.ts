import { describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { compileActionCliCommands } from './compiledCommands';
import { buildActionCliHelpModel } from './commandHelp';
import { composeActionCliInput, parseActionCliCommandInput } from './parseCommandInput';

describe('Group label JSON through the public Action CLI contract', () => {
    it.each(['teams.groups.create', 'teams.groups.update'] as const)('%s help and parsing preserve sealed labels and explicit null', actionId => {
        const spec = getActionSpec(actionId);
        const binding = spec.cli?.commands?.[0];
        if (!binding) throw new Error('Group Action CLI declaration missing');
        const command = compileActionCliCommands([{ spec, binding }])[0];
        if (!command) throw new Error('Group Action CLI failed to compile');
        const help = buildActionCliHelpModel(command);
        expect(help.options.find(option => option.label.includes('--name'))?.label).toBe('--name-json <json>');
        expect(help.options.find(option => option.label.includes('--description'))?.label).toBe('--description-json <json>');
        const label = { content: { t: 'plain' as const, v: 'Structured label' }, recipients: [] };
        const compose = (description: unknown) => {
            const parsed = parseActionCliCommandInput(command, [...command.path,
                '--v', '1', '--team-id', 'team-1', '--group-id', 'group-1', '--name-json', JSON.stringify(label),
                '--description-json', JSON.stringify(description),
                ...(actionId === 'teams.groups.create' ? ['--request-key', 'group-label-cli'] : [])]);
            if (!parsed.ok) return parsed;
            return composeActionCliInput({ parsed, canonicalSchema: spec.inputSchema,
                callerSchema: command.callerSchema, wholeInputSchema: command.wholeInputSchema,
                bindInput: spec.cli?.bindInput, context: { actionId, invocationId: 'group-label-cli', output: 'json' } });
        };
        expect(compose(label)).toMatchObject({ ok: true, input: { name: label, description: label } });
        expect(compose(null)).toMatchObject({ ok: true, input: { description: null } });
        expect(compose('raw new text')).toMatchObject({ ok: false });
        expect(compose({ ...label, legacyPlaintext: true })).toMatchObject({ ok: false });
    });
});
