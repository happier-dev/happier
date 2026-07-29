import {
    exchangeOpenAiCodexDeviceAuthApprovalForBundle,
    pollOpenAiCodexDeviceAuthOnce,
    startOpenAiCodexDeviceAuth,
} from "./openaiCodexDeviceAuth";
import {
    claimOpenAiCodexDeviceAuthTransactionWork,
    completeOpenAiCodexDeviceAuthTokenExchange,
    createOpenAiCodexDeviceAuthTransaction,
    expireOpenAiCodexDeviceAuthTokenExchange,
    settleOpenAiCodexDeviceAuthProviderApproved,
    settleOpenAiCodexDeviceAuthProviderPending,
} from "./openAiCodexDeviceAuthTransactionStore";

export type StartOpenAiCodexDeviceAuthTransactionResult = Readonly<{
    transactionId: string;
    userCode: string;
    intervalMs: number;
    verificationUrl: string;
}>;

export async function startOpenAiCodexDeviceAuthTransaction(input: Readonly<{
    accountId: string;
    recipientPublicKeyB64Url: string;
    now: number;
    fetcher?: typeof fetch;
}>): Promise<StartOpenAiCodexDeviceAuthTransactionResult> {
    const started = await startOpenAiCodexDeviceAuth({ fetcher: input.fetcher });
    const transaction = await createOpenAiCodexDeviceAuthTransaction({
        accountId: input.accountId,
        recipientPublicKeyB64Url: input.recipientPublicKeyB64Url,
        deviceAuthId: started.deviceAuthId,
        userCode: started.userCode,
        intervalMs: started.intervalMs,
        now: input.now,
    });
    return {
        transactionId: transaction.transactionId,
        userCode: started.userCode,
        intervalMs: started.intervalMs,
        verificationUrl: started.verificationUrl,
    };
}

export type PollOpenAiCodexDeviceAuthTransactionResult =
    | Readonly<{ status: "not_found" }>
    | Readonly<{ status: "expired" }>
    | Readonly<{ status: "pending"; retryAfterMs: number }>
    | Readonly<{ status: "success"; bundle: string }>;

export async function pollOpenAiCodexDeviceAuthTransaction(input: Readonly<{
    accountId: string;
    transactionId: string;
    now: number;
    fetcher?: typeof fetch;
}>): Promise<PollOpenAiCodexDeviceAuthTransactionResult> {
    const fetcher = input.fetcher ?? fetch;
    const work = await claimOpenAiCodexDeviceAuthTransactionWork({
        accountId: input.accountId,
        transactionId: input.transactionId,
        now: input.now,
    });
    if (work.kind === "not_found") return { status: "not_found" };
    if (work.kind === "expired") return { status: "expired" };
    if (work.kind === "pending") return { status: "pending", retryAfterMs: work.retryAfterMs };
    if (work.kind === "completed") return { status: "success", bundle: work.bundle };

    if (work.kind === "provider_poll") {
        let providerResult: Awaited<ReturnType<typeof pollOpenAiCodexDeviceAuthOnce>>;
        try {
            providerResult = await pollOpenAiCodexDeviceAuthOnce({
                fetcher,
                deviceAuthId: work.deviceAuthId,
                userCode: work.userCode,
                intervalMs: work.intervalMs,
            });
        } catch (error) {
            await settleOpenAiCodexDeviceAuthProviderPending({
                claim: work.claim,
                accountId: input.accountId,
                now: Date.now(),
                retryAfterMs: work.intervalMs,
            });
            throw error;
        }
        if (providerResult.status === "pending") {
            await settleOpenAiCodexDeviceAuthProviderPending({
                claim: work.claim,
                accountId: input.accountId,
                now: Date.now(),
                retryAfterMs: providerResult.retryAfterMs,
            });
            return { status: "pending", retryAfterMs: providerResult.retryAfterMs };
        }
        const approvalStored = await settleOpenAiCodexDeviceAuthProviderApproved({
            claim: work.claim,
            accountId: input.accountId,
            authorizationCode: providerResult.authorizationCode,
            codeVerifier: providerResult.codeVerifier,
            now: Date.now(),
        });
        if (!approvalStored) return { status: "pending", retryAfterMs: 1 };
        return await pollOpenAiCodexDeviceAuthTransaction({
            ...input,
            now: Date.now(),
            fetcher,
        });
    }

    try {
        const exchanged = await exchangeOpenAiCodexDeviceAuthApprovalForBundle({
            fetcher,
            publicKeyB64Url: work.recipientPublicKeyB64Url,
            authorizationCode: work.authorizationCode,
            codeVerifier: work.codeVerifier,
            now: Date.now(),
        });
        const completed = await completeOpenAiCodexDeviceAuthTokenExchange({
            claim: work.claim,
            accountId: input.accountId,
            now: Date.now(),
            bundle: exchanged.bundleB64Url,
        });
        if (!completed) return { status: "expired" };
        return { status: "success", bundle: exchanged.bundleB64Url };
    } catch (error) {
        await expireOpenAiCodexDeviceAuthTokenExchange({
            claim: work.claim,
            accountId: input.accountId,
            now: Date.now(),
        });
        throw error;
    }
}
