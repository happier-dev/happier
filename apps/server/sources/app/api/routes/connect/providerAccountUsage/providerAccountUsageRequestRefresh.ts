import { eventRouter } from "@/app/events/eventRouter";
import { requestProviderAccountUsageRefresh as writeRefreshRequest } from "./recordStorage";

/** Persist the request before waking this account's daemons; ordinary polling covers missed socket hints. */
export async function requestProviderAccountUsageRefresh(params: Readonly<{
    accountId: string;
    recordId: string;
}>): Promise<"written" | "not_found"> {
    const result = await writeRefreshRequest(params);
    if (result === "written") {
        eventRouter.emitEphemeral({ userId: params.accountId, recipientFilter: { type: "user-machine-scoped-only" },
            payload: { type: "provider-account-usage-refresh-requested" } });
    }
    return result;
}
