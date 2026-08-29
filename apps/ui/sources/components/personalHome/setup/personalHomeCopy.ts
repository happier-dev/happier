import { tLoose } from '@/text';

export function personalHomeCopy(key: string, fallback: string): string {
    const value = tLoose(`personalHome.bootstrap.${key}`);
    return value === `personalHome.bootstrap.${key}` ? fallback : value;
}
