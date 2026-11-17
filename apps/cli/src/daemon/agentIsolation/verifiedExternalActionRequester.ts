import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';

/** Produced only by the original Action ingress after its complete root/effect
 * verification. An authorization object copied from another context is not proof. */
export type VerifiedExternalActionRequester = Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1;
    isCurrent: () => Promise<boolean>;
}>;

const verifiedOriginalRequester = Symbol('verifiedOriginalActionRequester');
type VerifiedRequesterAuthorization = ExternalActionExecutionAuthorizationV1 & {
    [verifiedOriginalRequester]?: VerifiedExternalActionRequester;
};

/** Keep the ingress proof with its incumbent authorization when approval replay
 * rebuilds the Action context. Neither JSON nor a requester projection can mint it. */
export function retainVerifiedExternalActionRequester(
    proof: VerifiedExternalActionRequester,
): ExternalActionExecutionAuthorizationV1 {
    const authorization: ExternalActionExecutionAuthorizationV1 = { ...proof.authorization };
    for (const key of Reflect.ownKeys(proof.authorization)) {
        if (key === verifiedOriginalRequester) continue;
        const descriptor = Object.getOwnPropertyDescriptor(proof.authorization, key);
        if (descriptor) Object.defineProperty(authorization, key, descriptor);
    }
    Object.defineProperty(authorization, verifiedOriginalRequester, {
        value: { authorization, isCurrent: proof.isCurrent } satisfies VerifiedExternalActionRequester,
        enumerable: false,
    });
    return Object.freeze(authorization);
}

/** Read only the self-bound host proof retained by its original ingress owner. */
export function readRetainedVerifiedExternalActionRequester(
    authorization?: ExternalActionExecutionAuthorizationV1,
): VerifiedExternalActionRequester | undefined {
    const proof = (authorization as VerifiedRequesterAuthorization | undefined)?.[verifiedOriginalRequester];
    return proof?.authorization === authorization ? proof : undefined;
}
