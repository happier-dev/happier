import type {
  DatabaseCellV1,
  DatabaseColumnV1,
  DatabaseDescriptorV1,
  DatabaseRelationStructureV1,
  DatabaseRelationSummaryV1,
  DatabaseRowV1,
} from '@happier-dev/plugin-sdk/database';

/**
 * Dev-only daemon answers for the Database workbench specimen: the lab's `billing_dev` (PostgreSQL 16.4,
 * eleven tables, two views), so the real surfaces render at the lab's density without a Machine.
 */

const WORKSPACE = Object.freeze({
  serverId: 'home',
  machineId: 'macbook-pro',
  workspaceId: 'billing-api-main',
  rootPath: '/Users/leeroy/dev/billing-api',
});

export const BILLING_SCOPE = Object.freeze({
  kind: 'worktree' as const,
  accountId: 'dev-account',
  installationId: 'dev-installation',
  projectKey: 'billing-api',
  workspace: WORKSPACE,
});

export const BILLING_DEV: DatabaseDescriptorV1 = {
  target: {
    kind: 'worktree',
    accountId: BILLING_SCOPE.accountId,
    installationId: BILLING_SCOPE.installationId,
    projectKey: BILLING_SCOPE.projectKey,
    workspace: WORKSPACE,
    source: { kind: 'service', serviceId: 'web', variable: 'DATABASE_URL' },
  },
  label: 'billing_dev',
  engine: 'postgresql',
  origin: { label: 'web' },
  endpointLabel: 'localhost:5432',
  placement: {
    serverId: 'home',
    accountId: BILLING_SCOPE.accountId,
    machineId: WORKSPACE.machineId,
    installationId: BILLING_SCOPE.installationId,
  },
  capabilities: [],
  access: { canRead: true, canWrite: false },
};

const MB = 1_000_000;
function table(
  name: string,
  rows: number,
  dataBytes: number,
  indexBytes: number,
): DatabaseRelationSummaryV1 {
  return {
    relation: { schema: 'public', name },
    kind: 'table',
    estimatedRows: String(rows),
    size: {
      bytes: String(Math.round(dataBytes + indexBytes)),
      tableBytes: String(Math.round(dataBytes)),
      indexBytes: String(Math.round(indexBytes)),
      measurement: 'table_bytes_estimate',
    },
  } as DatabaseRelationSummaryV1;
}

export const RELATIONS: readonly DatabaseRelationSummaryV1[] = [
  table('customers', 12_040, 2.6 * MB, 1.6 * MB),
  table('invoices', 48_210, 18 * MB, 13 * MB),
  table('invoice_lines', 212_400, 61 * MB, 35 * MB),
  table('payments', 41_380, 11 * MB, 7 * MB),
  table('plans', 9, 16_000, 32_000),
  table('subscriptions', 11_020, 3.1 * MB, 1.9 * MB),
  table('webhook_events', 1_204_000, 544 * MB, 68 * MB),
  table('coupons', 0, 8_000, 16_000),
  table('audit_log', 388_100, 90 * MB, 6 * MB),
  {
    relation: { schema: 'public', name: 'active_subscriptions' },
    kind: 'view',
  },
  {
    relation: { schema: 'public', name: 'mrr_by_month' },
    kind: 'materialized_view',
    estimatedRows: '36',
  },
];

function column(
  name: string,
  nativeType: string,
  semanticType: DatabaseColumnV1['semanticType'],
  nullable = false,
): DatabaseColumnV1 & { nullable: boolean; generated: boolean } {
  return { name, nativeType, semanticType, nullable, generated: false };
}

const INVOICE_COLUMNS = [
  column('id', 'int8', 'integer'),
  column('customer_id', 'int8', 'integer'),
  column('number', 'text', 'text'),
  column('status', 'invoice_status', 'text'),
  column('amount_cents', 'int4', 'integer'),
  column('currency', 'bpchar(3)', 'text'),
  column('due_at', 'timestamptz', 'temporal'),
  column('paid_at', 'timestamptz', 'temporal', true),
  column('memo', 'text', 'text', true),
  column('metadata', 'jsonb', 'json'),
];

const CUSTOMERS = [
  3301, 1187, 4821, 2210, 905, 3301, 77, 6610, 1187, 4502, 2210, 318, 4821,
  1440, 77, 905,
];
const STATUSES = [
  'open',
  'paid',
  'paid',
  'uncollectible',
  'paid',
  'void',
  'paid',
  'open',
  'paid',
  'paid',
  'paid',
  'open',
  'paid',
  'paid',
  'paid',
  'paid',
];
const AMOUNTS = [
  64_000, 4_900, 124_000, 8_900, 31_000, 4_900, 298_000, 4_900, 4_900, 31_000,
  8_900, 64_000, 124_000, 4_900, 298_000, 4_900,
];
const CURRENCIES = [
  'EUR',
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'EUR',
  'USD',
  'EUR',
  'EUR',
  'CHF',
  'GBP',
  'EUR',
  'USD',
  'EUR',
  'USD',
  'EUR',
];

function temporal(value: string): DatabaseCellV1 {
  return { type: 'temporal', nativeType: 'timestamptz', value };
}

export const INVOICE_ROWS: readonly DatabaseRowV1[] = CUSTOMERS.map(
  (customer, index) => {
    const id = 48_212 - index;
    const day = String(30 - index).padStart(2, '0');
    const status = STATUSES[index]!;
    const metadata =
      index === 2
        ? '{"plan":"business","seats":40,"po":"PO-7731"}'
        : `{"plan":"${index % 3 ? 'team' : 'business'}","seats":${4 + index}}`;
    return {
      identity: {
        key: [{ column: 'id', value: { type: 'integer', value: String(id) } }],
        original: [],
      },
      cells: [
        { type: 'integer', value: String(id) },
        { type: 'integer', value: String(customer) },
        { type: 'text', value: `INV-2026-0${id - 43_400}` },
        { type: 'text', value: status },
        { type: 'integer', value: String(AMOUNTS[index]) },
        { type: 'text', value: CURRENCIES[index]! },
        temporal(`2026-11-${day} 23:59:00+01`),
        status === 'paid'
          ? temporal(
              `2026-11-${String(15 - (index % 10)).padStart(2, '0')} 18:02:11+01`,
            )
          : { type: 'null' },
        index === 2
          ? {
              type: 'text',
              value:
                'Includes 3 add-on seats for the design team (Mara, Jon, Ana) as discussed',
            }
          : { type: 'null' },
        { type: 'json', value: metadata },
      ],
    };
  },
);

const CUSTOMER_COLUMNS = [
  column('id', 'int8', 'integer'),
  column('name', 'text', 'text'),
  column('email', 'citext', 'text'),
  column('country', 'bpchar(2)', 'text'),
  column('plan', 'text', 'text'),
  column('created_at', 'timestamptz', 'temporal'),
];

const CUSTOMER_ROWS: readonly DatabaseRowV1[] = [
  [
    4821,
    'Northwind GmbH',
    'billing@northwind.de',
    'DE',
    'business',
    '2024-03-11 09:14:00+01',
  ],
  [
    3301,
    'Acme Robotics',
    'ap@acme-robotics.com',
    'US',
    'team',
    '2024-07-02 16:40:00+01',
  ],
  [
    2210,
    'Lumen Studio',
    'hello@lumen.studio',
    'GB',
    'team',
    '2025-01-19 11:05:00+01',
  ],
].map(([id, name, email, country, plan, created]) => ({
  identity: {
    key: [{ column: 'id', value: { type: 'integer', value: String(id) } }],
    original: [],
  },
  cells: [
    { type: 'integer', value: String(id) },
    { type: 'text', value: String(name) },
    { type: 'text', value: String(email) },
    { type: 'text', value: String(country) },
    { type: 'text', value: String(plan) },
    temporal(String(created)),
  ],
}));

export const ACTIVE_SUBSCRIPTIONS_DEFINITION = [
  'SELECT s.id,',
  '    s.customer_id,',
  '    c.name AS customer_name,',
  '    p.code AS plan,',
  '    s.seats,',
  '    s.current_period_end',
  '  FROM subscriptions s',
  '  JOIN customers c ON c.id = s.customer_id',
  '  JOIN plans p ON p.id = s.plan_id',
  ' WHERE s.canceled_at IS NULL',
  '   AND s.current_period_end > now();',
].join('\n');

const VIEW_COLUMNS = [
  column('id', 'int8', 'integer', true),
  column('customer_id', 'int8', 'integer', true),
  column('customer_name', 'text', 'text', true),
  column('plan', 'text', 'text', true),
  column('seats', 'int4', 'integer', true),
  column('current_period_end', 'timestamptz', 'temporal', true),
];

export function structureOf(name: string): DatabaseRelationStructureV1 {
  if (name === 'active_subscriptions')
    return {
      relation: { schema: 'public', name },
      kind: 'view',
      columns: VIEW_COLUMNS,
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
      viewDefinition: ACTIVE_SUBSCRIPTIONS_DEFINITION,
      capabilities: [],
    };
  if (name === 'customers')
    return {
      relation: { schema: 'public', name },
      kind: 'table',
      columns: CUSTOMER_COLUMNS,
      primaryKey: ['id'],
      indexes: [
        {
          name: 'customers_pkey',
          unique: true,
          primary: true,
          columns: [{ kind: 'column', column: 'id' }],
        },
      ],
      foreignKeys: [],
      incomingForeignKeys: [
        { name: 'invoices_customer_id_fkey', source: { schema: 'public', name: 'invoices' }, sourceColumns: ['customer_id'], targetColumns: ['id'] },
      ],
      capabilities: [],
    };
  return {
    relation: { schema: 'public', name: 'invoices' },
    kind: 'table',
    columns: INVOICE_COLUMNS,
    primaryKey: ['id'],
    indexes: [
      {
        name: 'invoices_pkey',
        unique: true,
        primary: true,
        columns: [{ kind: 'column', column: 'id' }],
      },
      {
        name: 'invoices_customer_id_idx',
        unique: false,
        primary: false,
        columns: [{ kind: 'column', column: 'customer_id' }],
      },
      {
        name: 'invoices_number_key',
        unique: true,
        primary: false,
        columns: [{ kind: 'column', column: 'number' }],
      },
    ],
    foreignKeys: [
      {
        name: 'invoices_customer_id_fkey',
        columns: ['customer_id'],
        target: { schema: 'public', name: 'customers' },
        targetColumns: ['id'],
      },
    ],
    // The tables whose rows point at an invoice (lab longValue "Referenced by").
    incomingForeignKeys: [
      { name: 'invoice_lines_invoice_id_fkey', source: { schema: 'public', name: 'invoice_lines' }, sourceColumns: ['invoice_id'], targetColumns: ['id'] },
      { name: 'payments_invoice_id_fkey', source: { schema: 'public', name: 'payments' }, sourceColumns: ['invoice_id'], targetColumns: ['id'] },
    ],
    capabilities: [],
  };
}

export function rowsOf(
  name: string,
): Readonly<{
  columns: readonly DatabaseColumnV1[];
  rows: readonly DatabaseRowV1[];
  estimate: string;
}> {
  if (name === 'customers')
    return {
      columns: CUSTOMER_COLUMNS,
      rows: CUSTOMER_ROWS,
      estimate: '12040',
    };
  if (name === 'active_subscriptions')
    return { columns: VIEW_COLUMNS, rows: [], estimate: '0' };
  return { columns: INVOICE_COLUMNS, rows: INVOICE_ROWS, estimate: '48210' };
}

/** The Console's parameterized read (lab `p7AddNow/params`): three invoices a customer still owes. */
export const CONSOLE_RESULT = {
  columns: [
    column('number', 'text', 'text'),
    column('amount_cents', 'int4', 'integer'),
    column('due_at', 'timestamptz', 'temporal'),
  ],
  rows: [
    ['INV-2026-04810', '124000', '2026-11-26 23:59:00+01'],
    ['INV-2026-04800', '124000', '2026-10-26 23:59:00+01'],
    ['INV-2026-04778', '98000', '2026-10-12 23:59:00+01'],
  ].map(([number, amount, due]) => ({
    cells: [
      { type: 'text', value: number! },
      { type: 'integer', value: amount! },
      temporal(due!),
    ] satisfies DatabaseCellV1[],
  })),
  completeness: { complete: true },
};

/** What Explain answers for the lab's open-invoices query (PostgreSQL's text plan). */
export const CONSOLE_PLAN = [
  'Limit  (cost=0.29..42.18 rows=50 width=48)',
  '  ->  Index Scan Backward using invoices_due_at_idx on invoices  (cost=0.29..1934.51 rows=2310 width=48)',
  "        Filter: ((customer_id = $1) AND (status = 'open'::invoice_status))",
].join('\n');

/** The Console draft and history this device kept (lab dbConsole): the open-invoices query, by customer. */
export const CONSOLE_DRAFT = {
  sql: [
    '-- Open invoices the dunning job should chase',
    'SELECT number, amount_cents, currency, due_at',
    'FROM invoices',
    "WHERE customer_id = $1 AND status = 'open'",
    'ORDER BY due_at;',
  ].join('\n'),
  history: [
    { sql: "SELECT count(*) FROM payments WHERE status = 'failed';" },
    { sql: 'SELECT id, email FROM customers ORDER BY created_at DESC LIMIT 20;' },
    { sql: 'SELECT * FROM invoice_lines WHERE invoice_id = 48210;' },
  ],
};
