import { randomUUID } from "node:crypto";

import packageJson from "../../../package.json";
import { parseBooleanEnv } from "@/config/env";
import { runCachedString } from "@/storage/cache/simpleCache";
import { debug, log } from "@/utils/logging/log";

/**
 * Anonymous self-hosted instance heartbeat.
 *
 * Once at startup and then once a day, the process that runs background jobs sends one
 * `instance_heartbeat` event to PostHog so we can count self-hosted servers and see their
 * versions and setup. It carries a random instance id plus version, flavor, db provider, os
 * and arch — no accounts, users, hostnames, URLs, IPs or content. The project key is public by
 * design. Disable with `HAPPIER_INSTANCE_PING=0` or `DO_NOT_TRACK=1`. Sending is best effort:
 * it never delays startup and every failure is swallowed with a debug log.
 */

export const INSTANCE_HEARTBEAT_CAPTURE_URL = "https://eu.i.posthog.com/i/v0/e/";
export const INSTANCE_HEARTBEAT_POSTHOG_KEY = "phc_2Rg55nD3SlBmjyAP4SYr5aScUohdnrtNa9rdggLwN0W";
export const INSTANCE_HEARTBEAT_ID_CACHE_KEY = "instance.heartbeat.id.v1";

const INSTANCE_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Env = Readonly<Record<string, string | undefined>>;

export type InstanceHeartbeatSetup = Readonly<{
    flavor: string;
    dbProvider: string;
}>;

export function isInstanceHeartbeatEnabled(env: Env): boolean {
    if (parseBooleanEnv(env.DO_NOT_TRACK, false)) return false;
    return parseBooleanEnv(env.HAPPIER_INSTANCE_PING, true);
}

export function buildInstanceHeartbeatEvent(params: InstanceHeartbeatSetup & Readonly<{ env: Env; instanceId: string }>) {
    return {
        api_key: params.env.HAPPIER_INSTANCE_PING_POSTHOG_KEY?.trim() || INSTANCE_HEARTBEAT_POSTHOG_KEY,
        event: "instance_heartbeat",
        distinct_id: params.instanceId,
        properties: {
            version: packageJson.version,
            flavor: params.flavor,
            db_provider: params.dbProvider,
            os: process.platform,
            arch: process.arch,
            $process_person_profile: false,
            $geoip_disable: true,
        },
    };
}

async function sendInstanceHeartbeat(params: InstanceHeartbeatSetup & Readonly<{ env: Env; fetch: typeof fetch }>): Promise<void> {
    try {
        const instanceId = await runCachedString(INSTANCE_HEARTBEAT_ID_CACHE_KEY, async () => randomUUID());
        const response = await params.fetch(INSTANCE_HEARTBEAT_CAPTURE_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(buildInstanceHeartbeatEvent({ ...params, instanceId })),
        });
        if (!response.ok) {
            debug({ module: "instance-heartbeat", status: response.status }, "Instance heartbeat was not accepted");
        }
    } catch (error) {
        debug({ module: "instance-heartbeat", error: String(error) }, "Instance heartbeat failed");
    }
}

export function startInstanceHeartbeat(
    params: InstanceHeartbeatSetup & Readonly<{ env?: Env; fetch?: typeof fetch }>,
): { stop: () => void } | null {
    const env = params.env ?? process.env;
    if (!isInstanceHeartbeatEnabled(env)) return null;

    log(
        { module: "instance-heartbeat" },
        "Instance heartbeat on: once a day this server sends a random instance id, version, flavor, db_provider, os and arch "
            + "to PostHog (eu.i.posthog.com). No accounts, users, hostnames, URLs or content. "
            + "Disable with HAPPIER_INSTANCE_PING=0 or DO_NOT_TRACK=1.",
    );

    const send = () => sendInstanceHeartbeat({
        env,
        flavor: params.flavor,
        dbProvider: params.dbProvider,
        fetch: params.fetch ?? fetch,
    });
    void send();
    const timer = setInterval(() => void send(), INSTANCE_HEARTBEAT_INTERVAL_MS);
    timer.unref?.();

    return { stop: () => clearInterval(timer) };
}
