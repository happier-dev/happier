import type { PluginConnectedAccountDescriptorContributionV2 } from '@happier-dev/protocol';
import { normalizeConnectedAccountConfiguredOrigin } from '@happier-dev/protocol/connect/execute-configuration-action';
export { normalizeConnectedAccountConfiguredOrigin } from '@happier-dev/protocol/connect/execute-configuration-action';

/**
 * The two configured facts of one Connected Account endpoint. `origin` is the
 * network origin used for routing and always means `scheme://host[:port]`.
 * `base` is the configured service base a source routes by, which for a
 * path-prefixed deployment carries the path segment the account lives beneath.
 * They are one declaration seen from two sides: `base` always begins with
 * `origin`.
 */
export type ConnectedAccountConfiguredEndpoint = Readonly<{
    origin: string;
    base: string;
}>;

/**
 * Normalizes a configured service base. A base may live beneath a path segment
 * — an Azure DevOps organization or collection, a path-prefixed self-hosted
 * deployment — but is otherwise held to the same exactness as an origin: HTTPS
 * only, no credentials, no query, no fragment, and no reinterpretation of what
 * the user configured. Only a trailing slash is normalized away; path case is
 * preserved because a collection segment is case-bearing.
 */
export function normalizeConnectedAccountConfiguredBase(
    value: string,
): ConnectedAccountConfiguredEndpoint {
    // One rejection for every malformed base, so an unparseable value cannot be
    // told apart from a rejected one by the message it produced.
    const rejected = () => new TypeError(
        'Connected-account configured base must be an exact credential-free HTTPS service base',
    );
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw rejected();
    }
    const path = url.pathname.replace(/\/+$/, '');
    const base = `${url.origin}${path}`;
    if (
        url.protocol !== 'https:'
        || url.username !== ''
        || url.password !== ''
        || url.search !== ''
        || url.hash !== ''
        || base !== value.replace(/\/+$/, '')
    ) {
        throw rejected();
    }
    return Object.freeze({
        origin: url.origin,
        base,
    });
}

function originEndpoint(
    value: string,
): ConnectedAccountConfiguredEndpoint {
    const origin = normalizeConnectedAccountConfiguredOrigin(value).origin;
    return Object.freeze({ origin, base: origin });
}

type ConnectedAccountDescriptorModeConfiguration = NonNullable<
    Extract<
        PluginConnectedAccountDescriptorContributionV2['authentication']['modes'][number],
        { configuration?: unknown }
    >['configuration']
>;

function readOwnEnumerableString(
    container: object,
    key: string,
): string | null {
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    return typeof descriptor.value === 'string' ? descriptor.value : null;
}

/**
 * The one selector from descriptor-typed endpoint fields to their configured,
 * host-normalized facts. Endpoint-semantic fields are never secret — the
 * canonical configuration normalizer rejects a secret field supplied as
 * plaintext — so every configured endpoint lives in the plain `values` record
 * of the exact configuration.
 *
 * Three endpoint semantics are published, and all resolve here so no consumer
 * gains a second route table. `connectedAccountOrigin` persists the origin the
 * user typed. `connectedAccountFixedOrigin` persists a closed *choice* whose
 * route the descriptor already declared in `originByValue`: the persisted value
 * is never treated as a URL, so a stored value outside the declared choice set
 * resolves to no origin at all rather than to something a caller could reach.
 * `connectedAccountBase` persists a service base that may live beneath a path
 * segment, and projects both facts: the base a source routes by and the origin
 * used to route the request.
 */
export function projectConnectedAccountConfiguredEndpoints(input: Readonly<{
    configuration: ConnectedAccountDescriptorModeConfiguration | undefined;
    values: Readonly<Record<string, unknown>>;
}>): readonly ConnectedAccountConfiguredEndpoint[] {
    if (!input.configuration) return Object.freeze([]);
    const endpoints: ConnectedAccountConfiguredEndpoint[] = [];
    for (const field of input.configuration.fields) {
        const semantic = Object.getOwnPropertyDescriptor(field, 'semantic');
        if (!semantic?.enumerable || !('value' in semantic)) continue;
        if (
            semantic.value !== 'connectedAccountOrigin'
            && semantic.value !== 'connectedAccountFixedOrigin'
            && semantic.value !== 'connectedAccountBase'
        ) {
            continue;
        }
        const configured = readOwnEnumerableString(input.values, field.id);
        if (configured === null) {
            throw new Error(
                `Connected-account configured endpoint field '${field.id}' is unavailable`,
            );
        }
        if (semantic.value === 'connectedAccountBase') {
            endpoints.push(normalizeConnectedAccountConfiguredBase(configured));
            continue;
        }
        if (semantic.value === 'connectedAccountOrigin') {
            endpoints.push(originEndpoint(configured));
            continue;
        }
        const originByValue = Object.getOwnPropertyDescriptor(field, 'originByValue');
        const routes = originByValue?.enumerable && 'value' in originByValue
            && typeof originByValue.value === 'object' && originByValue.value !== null
            ? originByValue.value
            : null;
        const routed = routes === null ? null : readOwnEnumerableString(routes, configured);
        if (routed === null) {
            throw new Error(
                `Connected-account configured endpoint field '${field.id}' declares no origin for its configured choice`,
            );
        }
        endpoints.push(originEndpoint(routed));
    }
    return Object.freeze(endpoints);
}
