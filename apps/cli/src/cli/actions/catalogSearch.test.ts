import { expect, it } from 'vitest';
import { getActionSpec, listActionCliCommandDeclarations } from '@happier-dev/protocol/actions/actionSpecs';
import { compileActionCliCommands } from './compiledCommands';
import { composeActionCliInput, parseActionCliCommandInput } from './parseCommandInput';

it.each(['automation', 'workflow_step'] as const)(
    'accepts a complete %s catalog through the ordinary actions search command', purpose => {
        const spec = getActionSpec('action.spec.search');
        const command = compileActionCliCommands(listActionCliCommandDeclarations()
            .filter(declaration => declaration.spec.id === spec.id))[0];
        if (!command) throw new Error('Missing actions search command');
        const parsed = parseActionCliCommandInput(command,
            ['actions', 'search', 'machine', 'command', '--purpose', purpose, '--limit-json', 'null']);
        if (!parsed.ok) throw new Error(parsed.message);
        expect(composeActionCliInput({ parsed, canonicalSchema: spec.inputSchema,
            callerSchema: command.callerSchema, wholeInputSchema: command.wholeInputSchema,
            bindInput: spec.cli?.bindInput,
            context: { actionId: spec.id, invocationId: 'catalog-search', commandPath: command.path },
        })).toMatchObject({ ok: true, input: { query: 'machine command', purpose, limit: null } });
    },
);
