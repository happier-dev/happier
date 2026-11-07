import { invokeTauri } from '@/utils/platform/tauri';

/** Opens a file on this computer in the program the OS uses for its type (desktop app only). */
export async function openLocalFileWithDefaultApp(path: string): Promise<void> {
    await invokeTauri<void>('desktop_open_path_with_default_app', { path });
}

/** Opens Explorer / Finder / the file manager with the file selected (desktop app only). */
export async function revealLocalFileInFileManager(path: string): Promise<void> {
    await invokeTauri<void>('desktop_reveal_path_in_file_manager', { path });
}
