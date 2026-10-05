/**
 * Copy owned by the Details chrome (details lab 2): the tab strip and the empty workspace. The
 * generic empty state speaks of Details itself; a host that knows what is worth opening (a Session
 * with changes) supplies its own invitation.
 */
type DetailsChromeTranslations = Readonly<{
    closeUnsavedTabA11y: string;
    emptyTitle: string;
    emptyReason: string;
    browseFiles: string;
    previewHint: string;
    reviewChanges: (params: Readonly<{ count: number }>) => string;
    reviewChangesReason: (params: Readonly<{ count: number }>) => string;
    splitNeedsWiderPane: string;
}>;

export const detailsChromeTranslations = {
    en: {
        closeUnsavedTabA11y: 'Close tab, it has unsaved changes',
        emptyTitle: 'Files, changes and commits open here',
        browseFiles: 'Browse files',
        previewHint: 'One click opens a preview tab; open it again to keep it.',
        emptyReason: 'Files, changes and commits you open show up here, next to where you opened them.',
        reviewChanges: ({ count }) => (count === 1 ? 'Review 1 change' : `Review ${count} changes`),
        reviewChangesReason: ({ count }) => (count === 1
            ? '1 file changed in this session. Read it here without leaving the conversation.'
            : `${count} files changed in this session. Read them here without leaving the conversation.`),
        splitNeedsWiderPane: 'Side by side needs a wider pane. Widen Details or use Focus.',
    },
    ca: {
        closeUnsavedTabA11y: 'Tanca la pestanya, té canvis sense desar',
        emptyTitle: 'Els fitxers, canvis i commits s’obren aquí',
        browseFiles: 'Explora els fitxers',
        previewHint: 'Un clic obre una previsualització; torna a obrir-la per conservar-la.',
        emptyReason: 'Els fitxers, canvis i commits que obris apareixen aquí, al costat d’on els has obert.',
        reviewChanges: ({ count }) => (count === 1 ? 'Revisa 1 canvi' : `Revisa ${count} canvis`),
        reviewChangesReason: ({ count }) => (count === 1
            ? 'Ha canviat 1 fitxer en aquesta sessió. Llegeix-lo aquí sense sortir de la conversa.'
            : `Han canviat ${count} fitxers en aquesta sessió. Llegeix-los aquí sense sortir de la conversa.`),
        splitNeedsWiderPane: 'La vista en paral·lel necessita un panell més ample. Amplia Detalls o fes servir Focus.',
    },
    de: {
        closeUnsavedTabA11y: 'Tab schließen, ungespeicherte Änderungen',
        emptyTitle: 'Dateien, Änderungen und Commits öffnen sich hier',
        browseFiles: 'Dateien durchsuchen',
        previewHint: 'Ein Klick öffnet eine Vorschau; öffne sie erneut, um sie zu behalten.',
        emptyReason: 'Dateien, Änderungen und Commits, die du öffnest, erscheinen hier – neben der Stelle, von der aus du sie geöffnet hast.',
        reviewChanges: ({ count }) => (count === 1 ? '1 Änderung prüfen' : `${count} Änderungen prüfen`),
        reviewChangesReason: ({ count }) => (count === 1
            ? 'In dieser Sitzung wurde 1 Datei geändert. Lies sie hier, ohne das Gespräch zu verlassen.'
            : `In dieser Sitzung wurden ${count} Dateien geändert. Lies sie hier, ohne das Gespräch zu verlassen.`),
        splitNeedsWiderPane: 'Nebeneinander braucht einen breiteren Bereich. Verbreitere Details oder nutze Fokus.',
    },
    es: {
        closeUnsavedTabA11y: 'Cerrar pestaña, tiene cambios sin guardar',
        emptyTitle: 'Aquí se abren archivos, cambios y commits',
        browseFiles: 'Explorar archivos',
        previewHint: 'Un clic abre una vista previa; ábrela de nuevo para conservarla.',
        emptyReason: 'Los archivos, cambios y commits que abras aparecen aquí, junto a donde los abriste.',
        reviewChanges: ({ count }) => (count === 1 ? 'Revisar 1 cambio' : `Revisar ${count} cambios`),
        reviewChangesReason: ({ count }) => (count === 1
            ? 'Cambió 1 archivo en esta sesión. Léelo aquí sin salir de la conversación.'
            : `Cambiaron ${count} archivos en esta sesión. Léelos aquí sin salir de la conversación.`),
        splitNeedsWiderPane: 'La vista en paralelo necesita un panel más ancho. Ensancha Detalles o usa Enfoque.',
    },
    fr: {
        closeUnsavedTabA11y: 'Fermer l’onglet, modifications non enregistrées',
        emptyTitle: 'Les fichiers, modifications et commits s’ouvrent ici',
        browseFiles: 'Parcourir les fichiers',
        previewHint: 'Un clic ouvre un aperçu ; ouvrez-le à nouveau pour le garder.',
        emptyReason: 'Les fichiers, modifications et commits que vous ouvrez apparaissent ici, à côté de l’endroit d’où vous les avez ouverts.',
        reviewChanges: ({ count }) => (count === 1 ? 'Relire 1 modification' : `Relire ${count} modifications`),
        reviewChangesReason: ({ count }) => (count === 1
            ? '1 fichier a changé dans cette session. Lisez-le ici sans quitter la conversation.'
            : `${count} fichiers ont changé dans cette session. Lisez-les ici sans quitter la conversation.`),
        splitNeedsWiderPane: 'La vue côte à côte demande un panneau plus large. Élargissez Détails ou utilisez Focus.',
    },
    it: {
        closeUnsavedTabA11y: 'Chiudi scheda, modifiche non salvate',
        emptyTitle: 'File, modifiche e commit si aprono qui',
        browseFiles: 'Sfoglia i file',
        previewHint: 'Un clic apre un’anteprima; aprila di nuovo per conservarla.',
        emptyReason: 'File, modifiche e commit che apri compaiono qui, accanto a dove li hai aperti.',
        reviewChanges: ({ count }) => (count === 1 ? 'Rivedi 1 modifica' : `Rivedi ${count} modifiche`),
        reviewChangesReason: ({ count }) => (count === 1
            ? 'In questa sessione è cambiato 1 file. Leggilo qui senza lasciare la conversazione.'
            : `In questa sessione sono cambiati ${count} file. Leggili qui senza lasciare la conversazione.`),
        splitNeedsWiderPane: 'Il confronto affiancato richiede un pannello più largo. Allarga Dettagli o usa Focus.',
    },
    ja: {
        closeUnsavedTabA11y: 'タブを閉じる（未保存の変更があります）',
        emptyTitle: 'ファイル、変更、コミットはここで開きます',
        browseFiles: 'ファイルを参照',
        previewHint: '1 回クリックするとプレビューが開きます。もう一度開くと保持されます。',
        emptyReason: '開いたファイル、変更、コミットは、開いた場所の隣のここに表示されます。',
        reviewChanges: ({ count }) => `${count} 件の変更を確認`,
        reviewChangesReason: ({ count }) => `このセッションで ${count} 個のファイルが変更されました。会話を離れずにここで確認できます。`,
        splitNeedsWiderPane: '左右に並べて表示するには、もっと広いパネルが必要です。詳細を広げるか、フォーカスを使ってください。',
    },
    pl: {
        closeUnsavedTabA11y: 'Zamknij kartę, ma niezapisane zmiany',
        emptyTitle: 'Tutaj otwierają się pliki, zmiany i commity',
        browseFiles: 'Przeglądaj pliki',
        previewHint: 'Kliknięcie otwiera podgląd; otwórz go ponownie, aby zachować kartę.',
        emptyReason: 'Otwierane pliki, zmiany i commity pojawiają się tutaj, obok miejsca, z którego je otworzono.',
        reviewChanges: ({ count }) => (count === 1 ? 'Przejrzyj 1 zmianę' : `Przejrzyj zmiany (${count})`),
        reviewChangesReason: ({ count }) => (count === 1
            ? 'W tej sesji zmienił się 1 plik. Przeczytaj go tutaj, nie opuszczając rozmowy.'
            : `W tej sesji zmieniły się pliki (${count}). Przeczytaj je tutaj, nie opuszczając rozmowy.`),
        splitNeedsWiderPane: 'Widok obok siebie wymaga szerszego panelu. Poszerz Szczegóły lub użyj trybu skupienia.',
    },
    pt: {
        closeUnsavedTabA11y: 'Fechar aba, tem alterações não salvas',
        emptyTitle: 'Arquivos, alterações e commits abrem aqui',
        browseFiles: 'Explorar arquivos',
        previewHint: 'Um clique abre uma prévia; abra de novo para manter a aba.',
        emptyReason: 'Os arquivos, alterações e commits que você abre aparecem aqui, ao lado de onde você os abriu.',
        reviewChanges: ({ count }) => (count === 1 ? 'Revisar 1 alteração' : `Revisar ${count} alterações`),
        reviewChangesReason: ({ count }) => (count === 1
            ? '1 arquivo mudou nesta sessão. Leia-o aqui sem sair da conversa.'
            : `${count} arquivos mudaram nesta sessão. Leia-os aqui sem sair da conversa.`),
        splitNeedsWiderPane: 'A visualização lado a lado precisa de um painel mais largo. Amplie Detalhes ou use Foco.',
    },
    ru: {
        closeUnsavedTabA11y: 'Закрыть вкладку, есть несохранённые изменения',
        emptyTitle: 'Здесь открываются файлы, изменения и коммиты',
        browseFiles: 'Открыть файлы',
        previewHint: 'Один щелчок открывает предпросмотр; откройте снова, чтобы сохранить вкладку.',
        emptyReason: 'Файлы, изменения и коммиты, которые вы открываете, появляются здесь — рядом с местом, откуда вы их открыли.',
        reviewChanges: ({ count }) => `Просмотреть изменения (${count})`,
        reviewChangesReason: ({ count }) => `В этой сессии изменено файлов: ${count}. Прочитайте их здесь, не покидая разговор.`,
        splitNeedsWiderPane: 'Для сравнения рядом нужна более широкая панель. Расширьте «Подробности» или включите фокус.',
    },
    'zh-Hans': {
        closeUnsavedTabA11y: '关闭标签页，有未保存的更改',
        emptyTitle: '文件、更改和提交在这里打开',
        browseFiles: '浏览文件',
        previewHint: '单击打开预览标签页；再次打开即可保留。',
        emptyReason: '你打开的文件、更改和提交会显示在这里，就在你打开它们的位置旁边。',
        reviewChanges: ({ count }) => `查看 ${count} 处更改`,
        reviewChangesReason: ({ count }) => `此会话中有 ${count} 个文件被更改。无需离开对话即可在这里阅读。`,
        splitNeedsWiderPane: '并排显示需要更宽的面板。请加宽详情或使用专注模式。',
    },
    'zh-Hant': {
        closeUnsavedTabA11y: '關閉分頁，有未儲存的變更',
        emptyTitle: '檔案、變更和提交在這裡開啟',
        browseFiles: '瀏覽檔案',
        previewHint: '按一下開啟預覽分頁；再次開啟即可保留。',
        emptyReason: '你開啟的檔案、變更和提交會顯示在這裡，就在你開啟它們的位置旁邊。',
        reviewChanges: ({ count }) => `檢視 ${count} 處變更`,
        reviewChangesReason: ({ count }) => `此工作階段中有 ${count} 個檔案被變更。無需離開對話即可在這裡閱讀。`,
        splitNeedsWiderPane: '並排顯示需要更寬的面板。請加寬詳細資料或使用專注模式。',
    },
} satisfies Record<string, DetailsChromeTranslations>;
