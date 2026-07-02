import { z } from "zod";
import {
    ConnectedServiceAuthGroupPolicyPatchV1Schema as ProtocolConnectedServiceAuthGroupPolicyPatchV1Schema,
    ConnectedServiceAuthGroupPolicyV1Schema as ProtocolConnectedServiceAuthGroupPolicyV1Schema,
} from "@happier-dev/protocol";

export const ConnectedServiceAuthGroupPolicyV1Schema = ProtocolConnectedServiceAuthGroupPolicyV1Schema;

export type ConnectedServiceAuthGroupPolicyV1 = z.infer<typeof ConnectedServiceAuthGroupPolicyV1Schema>;

export const ConnectedServiceAuthGroupPolicyPatchSchema = ProtocolConnectedServiceAuthGroupPolicyPatchV1Schema;

export type ConnectedServiceAuthGroupPolicyPatch = z.infer<typeof ConnectedServiceAuthGroupPolicyPatchSchema>;

export const DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1: ConnectedServiceAuthGroupPolicyV1 = Object.freeze({
    ...ConnectedServiceAuthGroupPolicyV1Schema.parse({}),
});

export function mergeConnectedServiceAuthGroupPolicyPatch(
    base: ConnectedServiceAuthGroupPolicyV1,
    patch: ConnectedServiceAuthGroupPolicyPatch | undefined,
): ConnectedServiceAuthGroupPolicyV1 {
    if (!patch) return base;
    return ConnectedServiceAuthGroupPolicyV1Schema.parse({
        ...base,
        ...patch,
        switchOn: {
            ...base.switchOn,
            ...patch.switchOn,
        },
    });
}

export function parseConnectedServiceAuthGroupPolicyJson(policyJson: string): ConnectedServiceAuthGroupPolicyV1 {
    try {
        return ConnectedServiceAuthGroupPolicyV1Schema.parse(JSON.parse(policyJson));
    } catch {
        return DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1;
    }
}

export function stringifyConnectedServiceAuthGroupPolicy(policy: ConnectedServiceAuthGroupPolicyV1): string {
    return JSON.stringify(ConnectedServiceAuthGroupPolicyV1Schema.parse(policy));
}
