export const publicSessionDeclarativeDocument = { version: 1, root: { kind: 'stack', children: [
    { kind: 'markdown', text: '**Experiment result**' },
    { kind: 'table', label: 'Samples', data: { kind: 'value', value: [{ sample: 'Copper', measured: 0.000017 }] }, rows: [],
        columns: [{ label: 'Sample', field: { path: ['sample'], type: 'string' } }, { label: 'Amount', field: { path: ['measured'], type: 'number' } }] },
    { kind: 'state', state: 'error', title: 'Source unavailable', description: 'The shared source cannot be reached.' },
] } };
