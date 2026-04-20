export type SocketRoomEventName = "update" | "ephemeral";

export type SocketRoomBroadcastOperator = Readonly<{
    emit: (eventName: SocketRoomEventName, payload: unknown) => void;
    except?: (room: string) => SocketRoomBroadcastOperator;
}>;

export type SocketRoomEmitter = Readonly<{
    to: (room: string | string[]) => SocketRoomBroadcastOperator;
}>;
