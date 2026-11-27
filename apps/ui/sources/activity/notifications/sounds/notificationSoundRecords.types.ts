export type NotificationSoundInfo = Readonly<{
    id: string;
    label: string;
    durationSeconds: number;
    kind: 'user' | 'plugin';
    src?: string;
}>;

export type NotificationSoundRecord = NotificationSoundInfo & Readonly<{ bytes: ArrayBuffer }>;

export type NotificationSoundRecords = Readonly<{
    get(id: string): Promise<NotificationSoundRecord | undefined>;
    put(info: NotificationSoundInfo, bytes: ArrayBuffer): Promise<void>;
    list(): Promise<readonly NotificationSoundInfo[]>;
    rename(id: string, label: string): Promise<NotificationSoundInfo | undefined>;
    remove(id: string): Promise<void>;
}>;
