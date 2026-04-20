import type { Redis } from "ioredis";

import { getRedisClient } from "@/storage/redis/redis";
import { log } from "@/utils/logging/log";

import type { SocketRoomBroadcastOperator, SocketRoomEmitter, SocketRoomEventName } from "./socketRoomEmitter";

type RedisStreamsClient = Pick<Redis, "xadd">;

type RedisStreamsEmitterOptions = Readonly<{
    maxLen: number;
    streamName?: string;
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
    private readonly streamName: string;
    private readonly namespace: string;
    private readonly maxLen: number;

    public constructor(
        private readonly client: RedisStreamsClient,
        params: RedisStreamsEmitterOptions,
    ) {
        this.streamName = params.streamName ?? "socket.io";
        this.namespace = params.namespace ?? "/";
        this.maxLen = params.maxLen;
    }

    public to(room: string | string[]) {
        const rooms = new Set(Array.isArray(room) ? room : [room]);
        return this.createBroadcastOperator(rooms, new Set());
    }

    private createBroadcastOperator(rooms: Set<string>, exceptRooms: Set<string>): SocketRoomBroadcastOperator {
        return {
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
}>): SocketRoomEmitter {
    return new RedisStreamsRoomEmitter(getRedisClient(), {
        maxLen: params.maxLen,
    });
}
