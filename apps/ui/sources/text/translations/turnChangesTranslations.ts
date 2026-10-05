/**
 * The one copy owner for a turn's changes card (WT9): the card that ends a turn in the transcript.
 * Every locale is a real translation; the card's two actions and its totals are read at every turn end.
 */
const en = {
    edited: ({ count }: { count: number }) => `Edited ${count} ${count === 1 ? 'file' : 'files'}`,
    walkThrough: 'Walk me through',
    openInFiles: 'Open in Files',
    fileCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'file' : 'files'}`,
    fileCountInFolders: ({ count, folders }: { count: number; folders: number }) =>
        `${count} ${count === 1 ? 'file' : 'files'} in ${folders} folders`,
    showMore: ({ count }: { count: number }) => `Show ${count} more`,
    groupA11y: 'Changes in this turn',
};

type TurnChangesTranslations = { -readonly [Key in keyof typeof en]: (typeof en)[Key] };

function translated(value: TurnChangesTranslations): TurnChangesTranslations {
    return value;
}

export const turnChangesTranslations = {
    en: { turnChanges: { card: en as TurnChangesTranslations } },
    ca: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count === 1 ? 'Fitxer editat' : 'Fitxers editats'}: ${count}`,
                walkThrough: 'Explica-m’ho',
                openInFiles: 'Obre a Fitxers',
                fileCount: ({ count }) => `${count} ${count === 1 ? 'fitxer' : 'fitxers'}`,
                fileCountInFolders: ({ count, folders }) => `${count} ${count === 1 ? 'fitxer' : 'fitxers'} en ${folders} carpetes`,
                showMore: ({ count }) => `Mostra’n ${count} més`,
                groupA11y: 'Canvis en aquest torn',
            }),
        },
    },
    de: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count} ${count === 1 ? 'Datei' : 'Dateien'} bearbeitet`,
                walkThrough: 'Erklär es mir',
                openInFiles: 'In Dateien öffnen',
                fileCount: ({ count }) => `${count} ${count === 1 ? 'Datei' : 'Dateien'}`,
                fileCountInFolders: ({ count, folders }) => `${count} ${count === 1 ? 'Datei' : 'Dateien'} in ${folders} Ordnern`,
                showMore: ({ count }) => `${count} weitere anzeigen`,
                groupA11y: 'Änderungen in diesem Zug',
            }),
        },
    },
    es: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count} ${count === 1 ? 'archivo editado' : 'archivos editados'}`,
                walkThrough: 'Explícamelo',
                openInFiles: 'Abrir en Archivos',
                fileCount: ({ count }) => `${count} ${count === 1 ? 'archivo' : 'archivos'}`,
                fileCountInFolders: ({ count, folders }) => `${count} ${count === 1 ? 'archivo' : 'archivos'} en ${folders} carpetas`,
                showMore: ({ count }) => `Mostrar ${count} más`,
                groupA11y: 'Cambios en este turno',
            }),
        },
    },
    fr: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count} ${count === 1 ? 'fichier modifié' : 'fichiers modifiés'}`,
                walkThrough: 'Explique-moi',
                openInFiles: 'Ouvrir dans Fichiers',
                fileCount: ({ count }) => `${count} ${count === 1 ? 'fichier' : 'fichiers'}`,
                fileCountInFolders: ({ count, folders }) => `${count} ${count === 1 ? 'fichier' : 'fichiers'} dans ${folders} dossiers`,
                showMore: ({ count }) => `Afficher ${count} de plus`,
                groupA11y: 'Modifications de ce tour',
            }),
        },
    },
    it: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count} ${count === 1 ? 'file modificato' : 'file modificati'}`,
                walkThrough: 'Spiegamelo',
                openInFiles: 'Apri in File',
                fileCount: ({ count }) => `${count} file`,
                fileCountInFolders: ({ count, folders }) => `${count} file in ${folders} cartelle`,
                showMore: ({ count }) => `Mostra altri ${count}`,
                groupA11y: 'Modifiche in questo turno',
            }),
        },
    },
    ja: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count} 個のファイルを編集`,
                walkThrough: '順に説明して',
                openInFiles: 'ファイルで開く',
                fileCount: ({ count }) => `${count} 個のファイル`,
                fileCountInFolders: ({ count, folders }) => `${folders} 個のフォルダーに ${count} 個のファイル`,
                showMore: ({ count }) => `さらに ${count} 件を表示`,
                groupA11y: 'このターンの変更',
            }),
        },
    },
    pl: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `Edytowane pliki: ${count}`,
                walkThrough: 'Przeprowadź mnie',
                openInFiles: 'Otwórz w Plikach',
                fileCount: ({ count }) => `Pliki: ${count}`,
                fileCountInFolders: ({ count, folders }) => `Pliki: ${count} w folderach: ${folders}`,
                showMore: ({ count }) => `Pokaż jeszcze ${count}`,
                groupA11y: 'Zmiany w tej turze',
            }),
        },
    },
    pt: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count} ${count === 1 ? 'arquivo editado' : 'arquivos editados'}`,
                walkThrough: 'Explique para mim',
                openInFiles: 'Abrir em Arquivos',
                fileCount: ({ count }) => `${count} ${count === 1 ? 'arquivo' : 'arquivos'}`,
                fileCountInFolders: ({ count, folders }) => `${count} ${count === 1 ? 'arquivo' : 'arquivos'} em ${folders} pastas`,
                showMore: ({ count }) => `Mostrar mais ${count}`,
                groupA11y: 'Alterações neste turno',
            }),
        },
    },
    ru: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `Изменено файлов: ${count}`,
                walkThrough: 'Объясни по шагам',
                openInFiles: 'Открыть в Файлах',
                fileCount: ({ count }) => `Файлов: ${count}`,
                fileCountInFolders: ({ count, folders }) => `Файлов: ${count}, папок: ${folders}`,
                showMore: ({ count }) => `Показать ещё ${count}`,
                groupA11y: 'Изменения в этом ходе',
            }),
        },
    },
    'zh-Hans': {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `编辑了 ${count} 个文件`,
                walkThrough: '带我看一遍',
                openInFiles: '在文件中打开',
                fileCount: ({ count }) => `${count} 个文件`,
                fileCountInFolders: ({ count, folders }) => `${folders} 个文件夹中的 ${count} 个文件`,
                showMore: ({ count }) => `再显示 ${count} 个`,
                groupA11y: '本轮的更改',
            }),
        },
    },
    'zh-Hant': {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `編輯了 ${count} 個檔案`,
                walkThrough: '帶我看一遍',
                openInFiles: '在檔案中開啟',
                fileCount: ({ count }) => `${count} 個檔案`,
                fileCountInFolders: ({ count, folders }) => `${folders} 個資料夾中的 ${count} 個檔案`,
                showMore: ({ count }) => `再顯示 ${count} 個`,
                groupA11y: '本輪的變更',
            }),
        },
    },
} as const;
