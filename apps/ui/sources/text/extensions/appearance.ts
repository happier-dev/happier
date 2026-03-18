import type { SupportedLanguage } from '../_all';

export const settingsAppearanceTranslationExtensions: Record<
    SupportedLanguage,
    {
        readonly settingsAppearance: {
            readonly sessionListDensity: {
                readonly title: string;
                readonly subtitle: string;
                readonly detailed: string;
                readonly detailedDescription: string;
                readonly cozy: string;
                readonly cozyDescription: string;
                readonly narrow: string;
                readonly narrowDescription: string;
            };
        };
    }
> = {
    en: {
        settingsAppearance: {
            sessionListDensity: {
                title: 'Session List Density',
                subtitle: 'Choose how sessions are displayed in the sidebar',
                detailed: 'Detailed',
                detailedDescription: 'Full-size rows with avatars and status',
                cozy: 'Cozy',
                cozyDescription: 'Slightly tighter rows with avatars',
                narrow: 'Narrow',
                narrowDescription: 'Minimal rows without avatars',
            },
        },
    },
    ru: {
        settingsAppearance: {
            sessionListDensity: {
                title: 'Плотность списка сессий',
                subtitle: 'Выберите, как сессии отображаются на боковой панели',
                detailed: 'Подробная',
                detailedDescription: 'Полноразмерные строки с аватарами и статусом',
                cozy: 'Средняя',
                cozyDescription: 'Более компактные строки с аватарами',
                narrow: 'Узкая',
                narrowDescription: 'Минимальные строки без аватаров',
            },
        },
    },
    pl: {
        settingsAppearance: {
            sessionListDensity: {
                title: 'Gęstość listy sesji',
                subtitle: 'Wybierz, jak sesje są wyświetlane na pasku bocznym',
                detailed: 'Szczegółowa',
                detailedDescription: 'Pełnowymiarowe wiersze z awatarami i statusem',
                cozy: 'Pośrednia',
                cozyDescription: 'Mniejsze wiersze z awatarami',
                narrow: 'Wąska',
                narrowDescription: 'Minimalne wiersze bez awatarów',
            },
        },
    },
    es: {
        settingsAppearance: {
            sessionListDensity: {
                title: 'Densidad de la lista de sesiones',
                subtitle: 'Elige cómo se muestran las sesiones en la barra lateral',
                detailed: 'Detallada',
                detailedDescription: 'Filas de tamaño completo con avatares y estado',
                cozy: 'Intermedia',
                cozyDescription: 'Filas más pequeñas con avatares',
                narrow: 'Estrecha',
                narrowDescription: 'Filas mínimas sin avatares',
            },
        },
    },
    it: {
        settingsAppearance: {
            sessionListDensity: {
                title: 'Densità elenco sessioni',
                subtitle: 'Scegli come visualizzare le sessioni nella barra laterale',
                detailed: 'Dettagliata',
                detailedDescription: 'Righe a dimensione completa con avatar e stato',
                cozy: 'Intermedia',
                cozyDescription: 'Righe più piccole con avatar',
                narrow: 'Stretta',
                narrowDescription: 'Righe minime senza avatar',
            },
        },
    },
    pt: {
        settingsAppearance: {
            sessionListDensity: {
                title: 'Densidade da lista de sessões',
                subtitle: 'Escolha como as sessões são exibidas na barra lateral',
                detailed: 'Detalhada',
                detailedDescription: 'Linhas de tamanho completo com avatares e status',
                cozy: 'Intermediário',
                cozyDescription: 'Linhas menores com avatares',
                narrow: 'Estreita',
                narrowDescription: 'Linhas mínimas sem avatares',
            },
        },
    },
    ca: {
        settingsAppearance: {
            sessionListDensity: {
                title: 'Densitat de la llista de sessions',
                subtitle: 'Tria com es mostren les sessions a la barra lateral',
                detailed: 'Detallada',
                detailedDescription: 'Files de mida completa amb avatars i estat',
                cozy: 'Intermèdia',
                cozyDescription: 'Files més petites amb avatars',
                narrow: 'Estreta',
                narrowDescription: 'Files mínimes sense avatars',
            },
        },
    },
    'zh-Hans': {
        settingsAppearance: {
            sessionListDensity: {
                title: '会话列表密度',
                subtitle: '选择侧边栏中会话的显示方式',
                detailed: '详细',
                detailedDescription: '带头像和状态的完整尺寸行',
                cozy: '中等',
                cozyDescription: '更小的带头像行',
                narrow: '窄版',
                narrowDescription: '不带头像的最简行',
            },
        },
    },
    'zh-Hant': {
        settingsAppearance: {
            sessionListDensity: {
                title: '工作階段列表密度',
                subtitle: '選擇工作階段在側邊欄中的顯示方式',
                detailed: '詳細',
                detailedDescription: '含頭像與狀態的完整尺寸列',
                cozy: '中等',
                cozyDescription: '更小的含頭像列',
                narrow: '窄版',
                narrowDescription: '不含頭像的最小列',
            },
        },
    },
    ja: {
        settingsAppearance: {
            sessionListDensity: {
                title: 'セッション一覧の密度',
                subtitle: 'サイドバーでのセッションの表示方法を選択',
                detailed: '詳細',
                detailedDescription: 'アバターとステータスを含む標準サイズの行',
                cozy: '中間',
                cozyDescription: 'アバター付きの小さめの行',
                narrow: '狭い',
                narrowDescription: 'アバターなしの最小行',
            },
        },
    },
};

export type SettingsAppearanceTranslationExtension = (typeof settingsAppearanceTranslationExtensions)['en'];
