import type { BrowserUploadFileV1 } from '@happier-dev/protocol/browser/input/v1';

/** Chooser and dropped host files use the same byte descriptor. */
export async function readBrowserUploadFile(file: File): Promise<BrowserUploadFileV1> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
    return { name: file.name, dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}
