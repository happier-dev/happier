import { preprocessStreamingMarkdown } from './preprocessStreamingMarkdown';

export async function repairStreamingMarkdownAsync(markdown: string): Promise<string> {
    await Promise.resolve();
    return preprocessStreamingMarkdown(markdown);
}
