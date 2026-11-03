import type { Redis } from "ioredis";

import { getRedisClient } from "@/storage/redis/redis";
import { log } from "@/utils/logging/log";

import {
    type SocketRoomBroadcastOperator,
    type SocketRoomEmitter,
    type SocketRoomEventName,
} from "./socketRoomEmitter";

type RedisStreamsClient = Pick<Redis, "xadd">;

type RedisStreamsEmitterOptions = Readonly<{
    maxLen: number;
    streamName: string;
    namespace?: string;
}>;

function writeToRedisStream(params: Readonly<{
    client: RedisStreamsClient;
    streamName: string;
    maxLen: number;
    payload: Record<string, string>;
}>): Promise<unknown> {
    const fields: Array<string | number> = [
        params.streamName,
        "MAXLEN",
        "~",
        params.maxLen,
        "*",
    ];

    for (const [key, value] of Object.entries(params.payload)) {
        fields.push(key, value);
    }

    return params.client.xadd(...(fields as [string, ...Array<string | number>]));
}

export class RedisStreamsRoomEmitter implements SocketRoomEmitter {
    public readonly sessionDeliveryMode = "forward_only" as const;
    private readonly streamName: string;
    private readonly namespace: string;
    private readonly maxLen: number;

    public constructor(
        private readonly client: RedisStreamsClient,
        params: RedisStreamsEmitterOptions,
    ) {
        this.streamName = params.streamName;
        this.namespace = params.namespace ?? "/";
        this.maxLen = params.maxLen;
    }

    public to(room: string | string[]) {
        const rooms = new Set(Array.isArray(room) ? room : [room]);
        return this.createBroadcastOperator(rooms, new Set());
    }

    /**
     * The worker's counterpart of `Server#serverSideEmit`: reaches the API nodes'
     * server-side handlers without joining the cluster as a peer.
     */
    public serverSideEmit(eventName: string, payload: unknown): Promise<void> {
        return this.writeServerSideEvent(eventName, payload);
    }

    private async writeServerSideEvent(eventName: string, payload: unknown): Promise<void> {
        try {
            await writeToRedisStream({
                client: this.client,
                streamName: this.streamName,
                maxLen: this.maxLen,
                payload: {
                    uid: "emitter",
                    nsp: this.namespace,
                    // Socket.IO's existing server-side event packet. The receiving
                    // API node resolves its own exact sockets and credential facts.
                    type: "9",
                    data: JSON.stringify({
                        packet: [eventName, payload],
                    }),
                },
            });
        } catch (error) {
            log(
                { module: "websocket", level: "warn", streamName: this.streamName },
                `Failed to forward server-side event ${eventName}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private createBroadcastOperator(rooms: Set<string>, exceptRooms: Set<string>): SocketRoomBroadcastOperator {
        return {
            disconnectSockets: (close: boolean) => {
                void writeToRedisStream({
                    client: this.client,
                    streamName: this.streamName,
                    maxLen: this.maxLen,
                    payload: {
                        uid: "emitter",
                        nsp: this.namespace,
                        type: "6",
                        data: JSON.stringify({
                            opts: { rooms: [...rooms], except: [...exceptRooms], flags: {} },
                            close,
                        }),
                    },
                }).catch((error) => {
                    log(
                        { module: "websocket", level: "warn", streamName: this.streamName },
                        `Failed to publish redis-streams room disconnect: ${error instanceof Error ? error.message : String(error)}`,
                    );
                });
            },
            emit: (eventName: SocketRoomEventName, payload: unknown) => {
                void writeToRedisStream({
                    client: this.client,
                    streamName: this.streamName,
                    maxLen: this.maxLen,
                    payload: {
                        uid: "emitter",
                        nsp: this.namespace,
                        type: "3",
                        data: JSON.stringify({
                            packet: {
                                type: 2,
                                nsp: this.namespace,
                                data: [eventName, payload],
                            },
                            opts: {
                                rooms: [...rooms],
                                except: [...exceptRooms],
                                flags: {},
                            },
                        }),
                    },
                }).catch((error) => {
                    log(
                        { module: "websocket", level: "warn", streamName: this.streamName },
                        `Failed to publish redis-streams room event: ${error instanceof Error ? error.message : String(error)}`,
                    );
                });
            },
            except: (roomToExclude: string) => {
                const nextExceptRooms = new Set(exceptRooms);
                nextExceptRooms.add(roomToExclude);
                return this.createBroadcastOperator(new Set(rooms), nextExceptRooms);
            },
        };
    }
}

export function createRedisStreamsRoomEmitter(params: Readonly<{
    maxLen: number;
    streamName: string;
}>): RedisStreamsRoomEmitter {
    return new RedisStreamsRoomEmitter(getRedisClient(), {
        maxLen: params.maxLen,
        streamName: params.streamName,
    });
}
