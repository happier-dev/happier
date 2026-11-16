import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { prepareHappierMcpToolInventory } from './registerHappierMcpBuiltInTools';

describe('Session MCP input schema preparation cost', () => {
    it('converts a static schema once per supplied context shape across Sessions', () => {
        let conversions = 0;
        const field = z.string();
        // Instrument the external Zod conversion boundary with the string's real JSON shape.
        field._zod.processJSONSchema = (_ctx, json) => { conversions++; json.type = 'string'; };
        const inputSchema = z.object({ sessionId: field });
        const inventory = { tools: [{ name: 'session_fixture', title: 'Session', description: 'Fixture',
            inputSchema, contextualDefaults: { sessionId: 'current_session' as const } }],
            actionToolNameToId: new Map([['session_fixture', 'session.get']]) };
        const prepare = (sessionId = '') => prepareHappierMcpToolInventory({ inventory, sessionId }).registrations[0]!.meta.inputSchema;
        const prepared = ['one', 'two', 'three'].map(prepare);
        expect(conversions).toBe(1);
        for (const schema of prepared) expect(z.toJSONSchema(schema).required ?? []).not.toContain('sessionId');
        const unbound = prepare();
        expect(conversions).toBe(2);
        expect(z.toJSONSchema(unbound).required).toContain('sessionId');
        prepare('four');
        expect(conversions).toBe(2);
    });
});
