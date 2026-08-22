const literal = (value) => ({ _def: { value } });
const member = (disc, value) => ({ shape: { [disc]: literal(value) } });
const union = (disc, values) => ({ _def: { discriminator: disc, options: values.map((v) => member(disc, v)) } });

export const AgentSessionRuntimeEventV1Schema = {
  _def: {
    schema: {
      _def: {
        options: [
          union('kind', [
            'input-accepted', 'input-rejected', 'input-custody-unknown', 'input-delivery-failed',
            'turn-start', 'turn-progress', 'turn-agent-id-observed', 'turn-complete', 'turn-failed',
            'turn-cancelled', 'turn-rollback-boundary', 'provider-session-id', 'runtime-ended',
            'message-delta', 'tool-call', 'tool-progress', 'tool-result',
            'transcript-message-committed', 'file-edit', 'usage-observed',
            'runtime-activity-snapshot',
            'brand-new-kind',
          ]),
          union('phase', ['started', 'completed']),
        ],
      },
    },
  },
};
