import { describe, expect, it, vi } from 'vitest';
import { renamePathPrompt } from './renamePathPrompt';
import { deletePathConfirm } from './deletePathConfirm';

const modal = vi.hoisted(() => ({ prompt: vi.fn<() => Promise<string | null>>(), confirm: vi.fn(async () => true), alert: vi.fn() }));
// Modal presentation is the user-interaction boundary; path handling remains real.
vi.mock('@/modal', () => ({ Modal: modal }));

describe('literal filesystem targets in mutation prompts', () => {
    it('preserves the existing name and treats its unchanged default as no rename', async () => {
        const currentPath = '  literal\nname  ';
        modal.prompt.mockResolvedValue(currentPath);
        expect(await renamePathPrompt({ currentPath })).toBeNull();
        expect(modal.prompt).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
            placeholder: currentPath, defaultValue: currentPath,
        });
    });
    it('shows the exact target bytes in delete confirmation', async () => {
        const path = '  literal\nname  ';
        expect(await deletePathConfirm({ path, kind: 'file' })).toEqual({ confirmed: true, recursive: false });
        expect(modal.confirm).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(path), expect.any(Object));
    });
});
