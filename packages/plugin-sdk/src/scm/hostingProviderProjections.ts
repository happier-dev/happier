import {
    ScmHostingProviderKindSchema as canonicalScmHostingProviderKindSchema,
    resolveScmHostingProviderFollowupAllowedBaseUrl as canonicalResolveScmHostingProviderFollowupAllowedBaseUrl,
} from '@happier-dev/protocol/scm';

import type {
    ScmHostingProviderKind,
    ScmHostingProviderRef,
} from './hostingProvider.js';

/** Canonical Protocol values with SDK-local declaration contracts. */
export const ScmHostingProviderKindSchema: {
    parse(value: unknown): ScmHostingProviderKind;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ScmHostingProviderKind }>
        | Readonly<{ success: false; error: unknown }>;
} = canonicalScmHostingProviderKindSchema;

export const resolveScmHostingProviderFollowupAllowedBaseUrl: (input: Readonly<{
    provider: ScmHostingProviderRef;
    allowedBaseUrl: string;
}>) => string | null = canonicalResolveScmHostingProviderFollowupAllowedBaseUrl;
