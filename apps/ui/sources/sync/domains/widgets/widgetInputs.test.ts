import { describe, expect, it } from 'vitest';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { resolveConfiguredWidgetInputs } from '@happier-dev/protocol/widgets';

const instance = (id: string, value: number): WidgetInstanceV1 => ({
    v: 1, id, definition: { kind: 'builtin', id: 'metric' }, bindings: { count: { kind: 'value', value } },
});
const descriptor = {
    inputs: { fields: [{ path: 'count', title: 'Count', widget: 'number' as const, required: true }] },
    inputSchema: { type: 'object' as const, properties: { count: { type: 'number' as const, minimum: 1 } }, required: ['count'], additionalProperties: false },
};

describe('configured widget input admission', () => {
    it('uses the complete admitted value schema, preserving independent instance values', () => {
        const resolve = (value: number) => resolveConfiguredWidgetInputs({
            instance: instance(`copy-${value}`, value), descriptor, providedContext: {}, viewerValues: {},
        });
        expect(resolve(0)).toMatchObject({ status: 'invalid', fields: [{ path: 'count', reasonCode: 'widget_input_schema_invalid' }] });
        expect(resolve(2)).toEqual({ status: 'ready', input: { count: 2 } });
    });

    it('retains a revoked pin failure instead of adopting followed context', () => {
        expect(resolveConfiguredWidgetInputs({ instance: instance('pin', 2), descriptor,
            providedContext: { count: [3] }, viewerValues: {},
            validateValue: () => ({ status: 'denied', reasonCode: 'widget_read_access_revoked' }),
        })).toMatchObject({ status: 'denied', fields: [{ path: 'count', reasonCode: 'widget_read_access_revoked' }] });
    });
});
