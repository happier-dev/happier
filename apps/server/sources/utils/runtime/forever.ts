import { AbortedExeption } from "./aborted";
import { backoff } from "./backoff";
import { keepAlive, shutdownSignal } from "../process/shutdown";
import { debug, warn } from "../logging/log";

export async function forever(
    name: string,
    callback: () => Promise<void>
) {
    void keepAlive(name, async () => {
        try {
            await backoff(
                async () => {
                    while (!shutdownSignal.aborted) {
                        try {
                            await callback();
                        } catch (error) {
                            if (AbortedExeption.isAborted(error)) {
                                break;
                            } else {
                                throw error;
                            }
                        }
                    }
                },
                shutdownSignal,
            );
        } catch (error) {
            // On shutdown, backoff() can abort while waiting between retries. That's not an error
            // we want to surface as an unhandled rejection.
            if (!AbortedExeption.isAborted(error)) {
                throw error;
            }
        }
    }).catch((error) => {
        // These tasks are background "keepAlive" loops; they must never take down the server
        // due to an unhandled promise rejection.
        if (AbortedExeption.isAborted(error)) return;
        if (shutdownSignal.aborted) {
            debug({ module: "forever", name, error }, "Forever loop error during shutdown");
            return;
        }
        warn({ module: "forever", name, error }, "Forever loop error");
    });
}
