import { createHash } from "node:crypto";

import {
    readHomeGovernancePolicyInTx,
    type HomeGovernancePolicyRecord,
} from "@/app/home/governance/governancePolicy";
import {
    IDENTITY_ENDPOINT_MAX_HEADER_BYTES,
    IDENTITY_ENDPOINT_MAX_RESPONSE_BYTES,
    type OutboundIdentityNetworkPolicy,
} from "@/app/net/outboundIdentityNetworkPolicy";
import type { Tx } from "@/storage/inTx";

import { validateManagedIdentityNetworkPolicyForSave } from "./managedIdentityNetworkPolicyValidation";


export { deploymentAllowsPrivateIdentityNetwork } from "./managedIdentityNetworkPolicyValidation";

/**
 * The deployment operator is the outer ceiling. A Home policy can select
 * private endpoints only when the deployment explicitly permits that class;
 * absent or malformed operator configuration remains public-only.
 */
export function resolveManagedIdentityNetworkPolicy(input: Readonly<{
    env: NodeJS.ProcessEnv;
    timeoutSeconds: number;
    home: HomeGovernancePolicyRecord;
}>): Readonly<{ policy: OutboundIdentityNetworkPolicy; fingerprint: string }> {
    const { home } = input;
    const narrowed = home.identityNetwork.status === "narrowed" ? home.identityNetwork.policy : null;
    const validNarrowed = narrowed
        && validateManagedIdentityNetworkPolicyForSave({ env: input.env, policy: narrowed }).status === "valid";
    const privatePolicy = validNarrowed && narrowed.mode === "private_allowlist"
        ? narrowed
        : null;
    const policy: OutboundIdentityNetworkPolicy = Object.freeze({
        address: privatePolicy
            ? Object.freeze({
                kind: "privateAllowlist" as const,
                hostnames: Object.freeze([...privatePolicy.hostnames]),
                cidrs: Object.freeze([...privatePolicy.cidrs]),
            })
            : Object.freeze({ kind: "publicOnly" as const }),
        allowedPorts: privatePolicy ? Object.freeze([...privatePolicy.ports]) : Object.freeze([443]),
        allowLoopbackHttp: false,
        maxResponseBytes: IDENTITY_ENDPOINT_MAX_RESPONSE_BYTES,
        maxHeaderBytes: IDENTITY_ENDPOINT_MAX_HEADER_BYTES,
        timeoutMs: input.timeoutSeconds * 1000,
    });
    const fingerprint = createHash("sha256")
        .update(JSON.stringify({ address: policy.address, allowedPorts: policy.allowedPorts }))
        .digest("base64url");
    return { policy, fingerprint };
}

export async function resolveManagedIdentityNetworkPolicyInTx(tx: Tx, input: Readonly<{
    env: NodeJS.ProcessEnv;
    timeoutSeconds: number;
}>): Promise<Readonly<{ policy: OutboundIdentityNetworkPolicy; fingerprint: string }>> {
    return resolveManagedIdentityNetworkPolicy({
        ...input,
        home: await readHomeGovernancePolicyInTx(tx),
    });
}
