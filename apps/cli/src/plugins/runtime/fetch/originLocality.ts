import { lookup } from 'node:dns/promises';

import {
    assessEndpointHostLocality,
    normalizeProviderEndpointUrlSyntax,
} from '@happier-dev/protocol/providers';

/** DNS is a genuine system boundary; every caller may substitute it. */
export type PluginNetworkAddressResolver = (hostname: string) => Promise<readonly string[]>;

export const resolvePluginNetworkAddresses: PluginNetworkAddressResolver = async (hostname) => (
    (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address)
);

export type PluginNetworkOriginLocality = 'public' | 'private';

export type PluginNetworkOriginAdmission = Readonly<{
    locality: PluginNetworkOriginLocality;
    validatedAddresses: readonly string[];
}>;

/**
 * Resolves and classifies one origin as a single admission fact. Callers that
 * dispatch HTTP must carry `validatedAddresses` to the socket owner; resolving
 * the hostname again after this decision would detach connection identity from
 * the policy that admitted it.
 */
export async function resolvePluginNetworkOriginAdmission(
    origin: string,
    options: Readonly<{ resolveAddresses?: PluginNetworkAddressResolver }> = {},
): Promise<PluginNetworkOriginAdmission> {
    try {
        const syntax = normalizeProviderEndpointUrlSyntax(origin);
        const resolvedAddresses = syntax.literalAddress
            ? undefined
            : await (options.resolveAddresses ?? resolvePluginNetworkAddresses)(syntax.hostname);
        const assessed = assessEndpointHostLocality({
            hostname: syntax.hostname,
            literalAddress: syntax.literalAddress,
            ...(resolvedAddresses ? { resolvedAddresses } : {}),
        });
        return Object.freeze({
            locality: assessed.locality === 'public' ? 'public' : 'private',
            validatedAddresses: Object.freeze([...assessed.resolvedAddresses]),
        });
    } catch {
        return Object.freeze({
            locality: 'private',
            validatedAddresses: Object.freeze([]),
        });
    }
}

/**
 * The one private-network decision for a plugin network origin. It delegates to
 * the endpoint-locality owner in Protocol, so a literal address and a hostname's
 * resolved A/AAAA answers reach exactly the same classification: a name that
 * resolves inside a private, loopback or otherwise non-public range can never be
 * admitted as public. This is credential-routing correctness — a Connected
 * Account credential must not leave for a private destination under a grant that
 * never declared one — not a judgement about the plugin holding it.
 *
 * Every outcome the locality owner refuses to classify — an unresolvable name, a
 * cloud-metadata destination, an unsafe or malformed address — is `private`, so
 * an origin only ever escapes the private-network requirement on positive
 * evidence that it is public.
 */
export async function assessPluginNetworkOriginLocality(
    origin: string,
    options: Readonly<{ resolveAddresses?: PluginNetworkAddressResolver }> = {},
): Promise<PluginNetworkOriginLocality> {
    return (await resolvePluginNetworkOriginAdmission(origin, options)).locality;
}

/**
 * Classifies a set of origins in one pass. Duplicates resolve once because a
 * scope and its fixed targets routinely name the same origin.
 */
export async function assessPluginNetworkOriginLocalities(
    origins: Iterable<string>,
    options: Readonly<{ resolveAddresses?: PluginNetworkAddressResolver }> = {},
): Promise<ReadonlyMap<string, PluginNetworkOriginLocality>> {
    const unique = [...new Set(origins)];
    const localities = await Promise.all(
        unique.map(async (origin) => await assessPluginNetworkOriginLocality(origin, options)),
    );
    return new Map(unique.map((origin, index) => [origin, localities[index] ?? 'private']));
}
