import type { SessionSelectionRow } from '@/components/sessions/selection/projectSessionSelectionRows';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

/** Dev-only pictures of an ordinary working desktop, drawn as SVG so the specimen needs no bundled art. */
const svgUri = (viewBox: string, width: number, height: number, body: string) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" font-family="Inter, -apple-system, sans-serif">${body}</svg>`)}`;

const field = (x: number, y: number, w: number, label: string, value: string) =>
    `<text x="${x}" y="${y - 10}" font-size="12" fill="#777">${label}</text><rect x="${x}" y="${y}" width="${w}" height="42" rx="7" fill="#fff" stroke="#ddd9d2"/><text x="${x + 14}" y="${y + 26}" font-size="14" fill="#222">${value}</text>`;
const row = (y: number, label: string, value: string) =>
    `<text x="866" y="${y}" font-size="14" fill="#444">${label}</text><text x="1252" y="${y}" font-size="14" fill="#222" text-anchor="end">${value}</text>`;
const item = (y: number, tone: string, name: string, meta: string, price: string) =>
    `<rect x="866" y="${y}" width="50" height="50" rx="7" fill="${tone}"/><text x="932" y="${y + 20}" font-size="14" font-weight="600" fill="#222">${name}</text><text x="932" y="${y + 40}" font-size="12" fill="#888">${meta}</text><text x="1252" y="${y + 20}" font-size="14" fill="#222" text-anchor="end">${price}</text>`;

const CHECKOUT_BODY = `
<rect width="1440" height="900" fill="#FBFAF7"/>
<rect width="1440" height="64" fill="#fff"/><rect y="64" width="1440" height="1" fill="#eee"/>
<text x="72" y="40" font-size="22" font-weight="700" fill="#1b1a18">Fieldnote</text>
<text x="500" y="38" font-size="14" fill="#555">Shop</text><text x="568" y="38" font-size="14" fill="#555">Journal</text><text x="640" y="38" font-size="14" fill="#555">Stores</text>
<text x="1320" y="38" font-size="14" font-weight="600" fill="#222">Cart (3)</text>
<text x="72" y="100" font-size="12" fill="#888">Cart › <tspan font-weight="600" fill="#222">Checkout</tspan></text>
<text x="72" y="140" font-size="17" font-weight="600" fill="#1b1a18">Contact</text>
${field(72, 176, 612, 'Email', 'ana.silva@fastmail.com')}
<text x="72" y="266" font-size="17" font-weight="600" fill="#1b1a18">Delivery</text>
${field(72, 300, 296, 'First name', 'Ana')}${field(388, 300, 296, 'Last name', 'Silva')}
${field(72, 378, 612, 'Address', 'Rua das Flores 128, 2º')}
${field(72, 456, 296, 'City', 'Lisbon')}${field(388, 456, 296, 'Postal code', '1200-195')}
<text x="72" y="546" font-size="17" font-weight="600" fill="#1b1a18">Payment</text>
${field(72, 570, 612, '', '4242 4242 4242 4242')}
${field(72, 648, 612, 'Name on card', 'Ana Silva')}
<rect x="836" y="130" width="440" height="560" rx="14" fill="#fff" stroke="#eee"/>
<text x="866" y="174" font-size="17" font-weight="600" fill="#1b1a18">Order summary</text>
${item(196, '#D9C7A8', 'Linen overshirt', 'Sand · M', '$98.00')}${item(264, '#E7DFCF', 'Canvas tote', 'Natural', '$42.00')}${item(332, '#5E5A55', 'Merino socks', 'Charcoal · 2 pairs', '$36.00')}
<rect x="866" y="402" width="386" height="1" fill="#eee"/>
${row(434, 'Subtotal', '$176.00')}${row(466, 'Shipping', 'Free')}${row(498, 'Discount · SPRING10', '−$17.60')}${row(530, 'Tax', '$12.67')}
<rect x="866" y="552" width="386" height="1" fill="#eee"/>
<text x="866" y="600" font-size="22" font-weight="700" fill="#1b1a18">Total</text>
<rect x="836" y="608" width="442" height="90" fill="#FBFAF7"/>
<rect x="836" y="606" width="440" height="84" fill="#fff" opacity="0"/>
<rect x="1090" y="580" width="210" height="52" rx="9" fill="#1F1D1B"/><text x="1195" y="612" font-size="15" font-weight="600" fill="#fff" text-anchor="middle">Pay $171.07</text>
<text x="836" y="722" font-size="12" fill="#888">Secure checkout · Free returns within 30 days</text>`;

export const CHECKOUT_PAGE_URI = svgUri('0 0 1440 900', 1440, 900, CHECKOUT_BODY);
/** The order summary's lower half: the small capture (lab `cw` S). */
export const CHECKOUT_CROP = { uri: svgUri('830 410 594 360', 594, 360, CHECKOUT_BODY), width: 594, height: 360 };
export const CHECKOUT_FULL = { uri: CHECKOUT_PAGE_URI, width: 1440, height: 900 };

const line = (y: number, parts: readonly (readonly [string, string])[]) =>
    `<text x="28" y="${y}" font-size="17" font-family="ui-monospace, Menlo, monospace" xml:space="preserve">${parts.map(([fill, text]) => `<tspan fill="${fill}">${text}</tspan>`).join('')}</text>`;
const G = '#8a8f98'; const W = '#d8d8d8'; const R = '#e0564f'; const K = '#3fb368';
export const TERMINAL_URI = svgUri('0 0 700 590', 700, 590, `<rect width="700" height="590" fill="#141414"/>
<rect width="700" height="28" fill="#242424"/><text x="350" y="19" font-size="12" fill="#999" text-anchor="middle">storefront — vitest — 98×30</text>
${line(66, [[G, '~/dev/storefront ❯ '], [W, 'pnpm vitest run checkout']])}
${line(106, [['#4d8fd6', ' RUN  '], [G, 'v3.2.4 ~/dev/storefront']])}
${line(146, [[K, ' ✓ '], [G, 'src/checkout/address.test.tsx (6 tests)']])}
${line(172, [[K, ' ✓ '], [G, 'src/checkout/promo.test.ts (9 tests)']])}
${line(198, [[R, ' ❯ '], [G, 'src/checkout/summary.test.tsx (4 tests | 1 failed)']])}
${line(250, [[R, ' FAIL '], [W, 'src/checkout/summary.test.tsx']])}
${line(276, [[R, 'AssertionError: expected total row to be inside']])}
${line(326, [[K, ' - Expected  '], [W, 'bottom ≤ 700']])}
${line(352, [[R, ' + Received  '], [W, 'bottom = 718']])}
${line(404, [[G, ' ❯ src/checkout/summary.test.tsx:42:31']])}
${line(456, [[W, ' Test Files  '], [R, '1 failed'], [G, ' | '], [K, '2 passed']])}
${line(482, [[W, '      Tests  '], [R, '1 failed'], [G, ' | '], [K, '18 passed']])}
${line(534, [[G, '~/dev/storefront ❯ ']])}`);

/** A quiet painted evening: enough tone that glass, dim and shadows have something to work against. */
export const WALLPAPER_URI = svgUri('0 0 1440 940', 1440, 940, `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fa3a8"/><stop offset=".55" stop-color="#c8bfa8"/><stop offset=".72" stop-color="#7fa7a2"/><stop offset=".84" stop-color="#d9c79d"/><stop offset="1" stop-color="#b09c74"/></linearGradient></defs><rect width="1440" height="940" fill="url(#s)"/>`);

/** The Session inventory the chooser reads in the specimen, shaped like the bridge's snapshot. */
const sessionRow = (id: string, label: string, agentId: string, place: string, extra: Partial<SessionSelectionRow> = {}): SessionSelectionRow => ({
    id: sessionAddressKey({ serverId: 'dev', sessionId: id }), address: { serverId: 'dev', sessionId: id }, label, subtitle: place, agentId, machineId: null,
    machineName: place.split(' · ').pop() ?? null, place, working: false, statusText: '', statusTone: 'neutral', activityLabel: '',
    group: 'recent', ...extra,
});
const BROWSER_PAGE_BODY = `<rect width="780" height="1000" fill="#F7F5EF"/><rect width="780" height="64" fill="#fff"/><rect y="64" width="780" height="1" fill="#E7E3D9"/>
<text x="24" y="40" font-family="Inter,system-ui" font-weight="700" font-size="22" fill="#23211C">Fieldnote</text><text x="756" y="40" text-anchor="end" font-family="Inter,system-ui" font-weight="600" font-size="15" fill="#23211C">Cart (3)</text>
<text x="24" y="104" font-family="Inter,system-ui" font-size="14" fill="#8C8778">Cart ›</text><text x="72" y="104" font-family="Inter,system-ui" font-weight="600" font-size="14" fill="#23211C">Checkout</text>
<rect x="24" y="128" width="732" height="688" rx="16" fill="#fff" stroke="#EEEBE3"/>
<text x="52" y="172" font-family="Inter,system-ui" font-weight="600" font-size="20" fill="#23211C">Order summary</text>
<rect x="52" y="200" width="56" height="56" rx="10" fill="#D9C7A6"/><text x="124" y="224" font-family="Inter,system-ui" font-weight="600" font-size="16" fill="#23211C">Linen overshirt</text><text x="124" y="246" font-family="Inter,system-ui" font-size="14" fill="#8C8778">Sand · M</text><text x="728" y="224" text-anchor="end" font-family="Inter,system-ui" font-size="16" fill="#23211C">$98.00</text>
<rect x="52" y="272" width="56" height="56" rx="10" fill="#E8DFCC"/><text x="124" y="296" font-family="Inter,system-ui" font-weight="600" font-size="16" fill="#23211C">Canvas tote</text><text x="124" y="318" font-family="Inter,system-ui" font-size="14" fill="#8C8778">Natural</text><text x="728" y="296" text-anchor="end" font-family="Inter,system-ui" font-size="16" fill="#23211C">$42.00</text>
<rect x="52" y="344" width="56" height="56" rx="10" fill="#5F5B54"/><text x="124" y="368" font-family="Inter,system-ui" font-weight="600" font-size="16" fill="#23211C">Merino socks</text><text x="124" y="390" font-family="Inter,system-ui" font-size="14" fill="#8C8778">Charcoal · 2 pairs</text><text x="728" y="368" text-anchor="end" font-family="Inter,system-ui" font-size="16" fill="#23211C">$36.00</text>
<rect x="52" y="424" width="676" height="1" fill="#EEEBE3"/>
<text x="52" y="462" font-family="Inter,system-ui" font-size="16" fill="#3B382F">Subtotal</text><text x="728" y="462" text-anchor="end" font-family="Inter,system-ui" font-size="16" fill="#23211C">$176.00</text>
<text x="52" y="498" font-family="Inter,system-ui" font-size="16" fill="#3B382F">Shipping</text><text x="728" y="498" text-anchor="end" font-family="Inter,system-ui" font-size="16" fill="#23211C">Free</text>
<text x="52" y="534" font-family="Inter,system-ui" font-size="16" fill="#3B382F">Discount · SPRING10</text><text x="728" y="534" text-anchor="end" font-family="Inter,system-ui" font-size="16" fill="#23211C">−$17.60</text>
<text x="52" y="570" font-family="Inter,system-ui" font-size="16" fill="#3B382F">Tax</text><text x="728" y="570" text-anchor="end" font-family="Inter,system-ui" font-size="16" fill="#23211C">$12.67</text>
<rect x="52" y="600" width="676" height="1" fill="#EEEBE3"/>
<text x="52" y="812" font-family="Inter,system-ui" font-weight="700" font-size="28" fill="#23211C">Total</text><text x="728" y="812" text-anchor="end" font-family="Inter,system-ui" font-weight="700" font-size="28" fill="#23211C">$171.07</text>
<rect x="24" y="830" width="732" height="56" rx="10" fill="#23211C"/><text x="390" y="865" text-anchor="middle" font-family="Inter,system-ui" font-weight="600" font-size="18" fill="#fff">Pay $171.07</text>
<text x="24" y="936" font-family="Inter,system-ui" font-weight="600" font-size="22" fill="#23211C">Contact</text>`;
export const BROWSER_PAGE_SOURCE = { uri: svgUri('0 0 780 1000', 1560, 2000, BROWSER_PAGE_BODY), width: 1560, height: 2000, scale: 2 };
/** What the page answers at a point, in viewport CSS pixels. */
export const BROWSER_PAGE_ELEMENTS = [
    { name: 'PayButton', selectorPath: 'main > div.checkout > button.pay', rect: { x: 24, y: 830, width: 732, height: 56 } },
    { name: 'TotalRow', selectorPath: 'main > div.summary > div.total', rect: { x: 26, y: 776, width: 728, height: 54 } },
    { name: 'OrderSummary', selectorPath: 'main > section.summary', rect: { x: 24, y: 128, width: 732, height: 688 } },
    { name: 'CheckoutPage', selectorPath: 'main', rect: { x: 0, y: 64, width: 780, height: 936 } },
] as const;

export const CHOOSER_ROWS: readonly SessionSelectionRow[] = [
    sessionRow('fix', 'Fix checkout total clipping', 'claude', 'storefront · MacBook Pro', { group: 'focused', working: true, statusText: 'Working' }),
    sessionRow('retry', 'Checkout retry states', 'codex', 'storefront · devbox', { statusTone: 'attention', statusText: 'Needs you' }),
    sessionRow('relay', 'Relay retry with backoff', 'codex', 'happier · devbox', { working: true, statusText: 'Working' }),
    sessionRow('review', 'Review #2481', 'claude', 'happier · Studio', { activityLabel: '2 h ago' }),
    sessionRow('pricing', 'Pricing page copy', 'claude', 'website · MacBook Pro', { activityLabel: 'Yesterday' }),
    sessionRow('changelog', 'Changelog draft', 'opencode', 'website · devbox', { disabledReason: 'DeepSeek V3 can’t read images' }),
];
export const WINDOW_TEXT = ['Fieldnote — Checkout', 'Cart › Checkout', 'Contact', 'Email: ana.silva@fastmail.com', 'Delivery',
    'First name: Ana · Last name: Silva · Address: Rua das Flores 128, 2º · City: Lisbon · Postal code: 1200-195',
    'Payment', 'Card ending 4242 · Name on card: Ana Silva', 'Order summary', 'Linen overshirt · Sand · M · $98.00',
    'Canvas tote · Natural · $42.00', 'Merino socks · Charcoal · 2 pairs · $36.00', 'Subtotal $176.00', 'Shipping Free',
    'Discount · SPRING10 −$17.60', 'Tax $12.67', 'Total', 'Pay $171.07', 'Secure checkout · Free returns within 30 days'].join('\n\n');
