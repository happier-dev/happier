/**
 * The demo story world: one believable Home for the key flows (Home, one Session turn with an
 * approval, files and diffs, terminal output). The QA bed `demo` profile seeds it through the
 * server's public API, so QA and the future demo app read the same story (owner ruling
 * 2026-11-18, `.project/plans/2026-11-11-demo-app/PROGRAM.md` "Owner amendment 2026-11-18").
 * Messages use the 0.2 Claude output shapes the seeder already writes for the other profiles.
 */

const FEATURED_TOOL_EDIT = 'toolu_demo_checkout_edit';
const FEATURED_TOOL_TEST = 'toolu_demo_checkout_test';

const SUMMARY_BEFORE = [
    'export function OrderSummary({ order }: Props) {',
    '  return (',
    '    <div className="summary summary--wide">',
    '      <LineItems items={order.items} columns={4} />',
    '      <Totals order={order} />',
    '    </div>',
    '  );',
    '}',
].join('\n');

const SUMMARY_AFTER = [
    'export function OrderSummary({ order }: Props) {',
    '  const compact = useMediaQuery("(max-width: 480px)");',
    '  return (',
    '    <div className={compact ? "summary summary--stacked" : "summary summary--wide"}>',
    '      <LineItems items={order.items} columns={compact ? 1 : 4} />',
    '      <Totals order={order} sticky={compact} />',
    '    </div>',
    '  );',
    '}',
].join('\n');

const TEST_OUTPUT = [
    '$ yarn test checkout',
    ' PASS  src/checkout/OrderSummary.test.tsx',
    '  ✓ stacks line items on a 390 px screen (41 ms)',
    '  ✓ keeps totals visible while scrolling (18 ms)',
    ' PASS  src/checkout/PaymentForm.test.tsx',
    '  ✓ submits with the keyboard (27 ms)',
    '',
    'Test Files  2 passed (2)',
    '     Tests  3 passed (3)',
].join('\n');

function userText(text: string): unknown {
    return { role: 'user', content: { type: 'text', text } };
}

function agentText(uuid: string, text: string): unknown {
    return { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid,
        message: { content: [{ type: 'text', text }] } } } };
}

function toolUse(uuid: string, id: string, name: string, input: Readonly<Record<string, unknown>>): unknown {
    return { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid,
        message: { content: [{ type: 'tool_use', id, name, input }] } } } };
}

function toolResult(uuid: string, toolUseId: string, content: string): unknown {
    return { role: 'agent', content: { type: 'output', data: { type: 'user', uuid,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } } } };
}

export const QA_BED_DEMO_STORY = {
    machine: { host: 'northstar-mbp', displayName: 'Maya’s MacBook Pro', platform: 'darwin', homeDir: '/Users/maya' },
    sessions: [
        { name: 'Checkout: fit the order summary on phones', path: '/Users/maya/northstar/web', featured: true },
        { name: 'Onboarding review', path: '/Users/maya/northstar/web', featured: false },
        { name: 'Payment retries', path: '/Users/maya/northstar/api', featured: false },
        { name: 'Launch notes draft', path: '/Users/maya/northstar/docs', featured: false },
    ],
    /** The featured Session's turn: prompt, plan, an Edit with its diff, a test run, and a closing note. */
    featuredTurn: (uuid: (index: number) => string): readonly unknown[] => [
        userText('The order summary is cramped on phones. Make it fit a 390 px screen and keep the totals visible.'),
        agentText(uuid(1), 'I’ll stack the line items on narrow screens and keep the totals pinned while you scroll.'),
        toolUse(uuid(2), FEATURED_TOOL_EDIT, 'Edit', {
            file_path: '/Users/maya/northstar/web/src/checkout/OrderSummary.tsx',
            old_string: SUMMARY_BEFORE,
            new_string: SUMMARY_AFTER,
        }),
        toolResult(uuid(3), FEATURED_TOOL_EDIT, 'The file /Users/maya/northstar/web/src/checkout/OrderSummary.tsx has been updated.'),
        toolUse(uuid(4), FEATURED_TOOL_TEST, 'Bash', { command: 'yarn test checkout', description: 'Run the checkout tests' }),
        toolResult(uuid(5), FEATURED_TOOL_TEST, TEST_OUTPUT),
        agentText(uuid(6), 'Checkout now fits phones and the tests pass. I’d like to publish a preview so you can try it on your phone.'),
    ],
    /** The approval the featured Session waits on. */
    pendingApproval: {
        id: 'demo-approval-checkout-preview',
        tool: 'Bash',
        arguments: { command: 'yarn deploy:preview checkout', description: 'Publish the checkout preview' },
    },
    /** Each other Session holds one short exchange. */
    shortExchange: (name: string, uuid: (index: number) => string): readonly unknown[] => [
        userText(`Pick up “${name}” where we left off.`),
        agentText(uuid(1), `Here is where “${name}” stands, and what I would do next.`),
    ],
    artifact: { title: 'Northstar launch notes', body: 'Checkout fits phones.\nPreview ready for review.\n' },
} as const;
