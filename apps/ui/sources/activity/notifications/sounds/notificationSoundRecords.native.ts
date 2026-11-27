import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { Directory, File, Paths } from 'expo-file-system';
import type { NotificationSoundInfo, NotificationSoundRecords } from './notificationSoundRecords.types';

function library() { return new Directory(Paths.document, 'notification-sounds'); }
function directoryFor(id: string) { return new Directory(library(), bytesToHex(sha256(id))); }

function readInfo(directory: Directory): NotificationSoundInfo | undefined {
    const file = new File(directory, 'info.json');
    if (!file.exists) return undefined;
    try { return JSON.parse(file.textSync()); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
}

export const notificationSoundRecords: NotificationSoundRecords = {
    async get(id) {
        const directory = directoryFor(id);
        const info = readInfo(directory);
        const wav = new File(directory, 'sound.wav');
        if (info?.id !== id || !wav.exists) return undefined;
        return { ...info, bytes: await wav.arrayBuffer() };
    },
    async put(info, bytes) {
        const directory = directoryFor(info.id);
        directory.create({ intermediates: true, idempotent: true });
        new File(directory, 'sound.wav').write(new Uint8Array(bytes));
        new File(directory, 'info.json').write(JSON.stringify(info));
    },
    async list() {
        const root = library();
        if (!root.exists) return [];
        return root.list().flatMap(directory => {
            if (!(directory instanceof Directory)) return [];
            const info = readInfo(directory);
            return info?.kind === 'user' && new File(directory, 'sound.wav').exists ? [info] : [];
        });
    },
    async rename(id, label) {
        const directory = directoryFor(id);
        const info = readInfo(directory);
        if (info?.kind !== 'user') return undefined;
        const renamed = { ...info, label };
        new File(directory, 'info.json').write(JSON.stringify(renamed));
        return renamed;
    },
    async remove(id) {
        const directory = directoryFor(id);
        if (directory.exists) directory.delete();
    },
};
