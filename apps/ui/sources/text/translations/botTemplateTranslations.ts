import type { SupportedLanguage } from '../_all';
import { botTemplateEditorTranslations } from './botTemplateEditorTranslations';
import { botStoreTranslations } from './botStoreTranslations';
import { botTemplateSharingTranslations, botTemplateVersionReportTranslations } from './botTemplateSharingTranslations';
import { botTemplatePresentationTranslations } from './botTemplatePresentationTranslations';
import { botTemplatePageTranslations } from './botTemplatePageTranslations';

function copy(words: readonly string[], language: SupportedLanguage) {
    return {
        ...botStoreTranslations(language),
        ...botTemplateEditorTranslations[language],
        ...botTemplateSharingTranslations[language],
        ...botTemplateVersionReportTranslations[language],
        ...botTemplatePresentationTranslations[language],
        ...botTemplatePageTranslations[language],
        title: words[0]!,
        leavePrompt: words[22]!,
        leaveKept: words[23]!,
        leftOut: words[24]!,
        description: words[25]!,
        private: words[26]!,
        giveCopy: words[1]!,
        giveCopyDescription: words[2]!,
        review: words[3]!,
        preview: words[4]!,
        instructions: words[5]!,
        firstTask: words[6]!,
        version: words[7]!,
        notes: words[8]!,
        recipient: words[9]!,
        privateDraft: words[10]!,
        shared: words[11]!,
        saving: words[12]!,
        unsaved: words[13]!,
        saved: words[14]!,
        saveFailed: words[15]!,
        conflict: words[16]!,
        reviewOther: words[17]!,
        useOtherBase: words[18]!,
        unavailable: words[19]!,
        madeFrom: ({ name }: { name: string }) => words[20]!.replace('{name}', () => name),
        byline: ({ author, version, sharing }: { author: string; version: string; sharing: string }) => words[21]!.replace('{author}', () => author).replace('{version}', () => version).replace('{sharing}', () => sharing),
    };
}

export type BotTemplateTranslations = ReturnType<typeof copy>;

export const botTemplateTranslations: Record<SupportedLanguage, BotTemplateTranslations> = {
    "en": copy(["Bot template", "Give a copy", "Make a template others can start their own from", "Review template", "What they get", "Instructions", "First task", "Release version", "Release notes", "Can-copy recipient", "Private draft", "Shared", "Saving…", "Unsaved changes", "Saved", "Your edits are kept. Try saving again.", "Another revision was saved. Review it before replacing your edits.", "Review other revision", "Use this revision as the save base", "Template unavailable", "Template · made from {name}", "By {author} · {version} · {sharing}", "Save before leaving? Your edits stay in this Account’s open draft until this app closes.", "Leave with edits kept", "Left out", "Description", "Private"], "en"),
    "fr": copy(["Modèle de Bot", "Donner une copie", "Créer un modèle dont d’autres partiront pour le leur", "Vérifier le modèle", "Ce qui est inclus", "Instructions", "Première tâche", "Version", "Notes de version", "Destinataire de la copie", "Brouillon privé", "Partagé", "Enregistrement…", "Modifications non enregistrées", "Enregistré", "Vos modifications sont conservées. Réessayez.", "Une autre révision a été enregistrée. Vérifiez-la avant de remplacer vos modifications.", "Vérifier l’autre révision", "Utiliser cette révision comme base", "Modèle indisponible", "Modèle · créé à partir de {name}", "Par {author} · {version} · {sharing}", "Enregistrer avant de quitter ? Les modifications restent dans le brouillon ouvert de ce compte jusqu’à la fermeture de l’application.", "Quitter en conservant les modifications", "Exclus", "Description", "Privé"], "fr"),
    "de": copy(["Bot-Vorlage", "Kopie weitergeben", "Eine Vorlage erstellen, aus der andere ihren eigenen machen", "Vorlage prüfen", "Enthaltene Inhalte", "Anweisungen", "Erste Aufgabe", "Version", "Versionshinweise", "Empfänger der Kopie", "Privater Entwurf", "Geteilt", "Wird gespeichert…", "Ungespeicherte Änderungen", "Gespeichert", "Deine Änderungen bleiben erhalten. Erneut speichern.", "Eine andere Revision wurde gespeichert. Prüfe sie vor dem Ersetzen.", "Andere Revision prüfen", "Diese Revision als Speicherbasis verwenden", "Vorlage nicht verfügbar", "Vorlage · erstellt aus {name}", "Von {author} · {version} · {sharing}", "Vor dem Verlassen speichern? Änderungen bleiben im offenen Entwurf dieses Kontos, bis die App geschlossen wird.", "Mit behaltenen Änderungen verlassen", "Ausgelassen", "Beschreibung", "Privat"], "de"),
    "es": copy(["Plantilla de Bot", "Dar una copia", "Crear una plantilla para que otros hagan el suyo", "Revisar plantilla", "Qué reciben", "Instrucciones", "Primera tarea", "Versión", "Notas de versión", "Destinatario de la copia", "Borrador privado", "Compartido", "Guardando…", "Cambios sin guardar", "Guardado", "Tus cambios se conservan. Intenta guardar de nuevo.", "Se guardó otra revisión. Revísala antes de reemplazar tus cambios.", "Revisar otra revisión", "Usar esta revisión como base", "Plantilla no disponible", "Plantilla · creada a partir de {name}", "Por {author} · {version} · {sharing}", "¿Guardar antes de salir? Los cambios permanecen en el borrador abierto de esta cuenta hasta cerrar la aplicación.", "Salir conservando los cambios", "Excluido", "Descripción", "Privado"], "es"),
    "it": copy(["Modello di Bot", "Dai una copia", "Crea un modello da cui altri creano il proprio", "Rivedi modello", "Cosa ricevono", "Istruzioni", "Prima attività", "Versione", "Note di versione", "Destinatario della copia", "Bozza privata", "Condiviso", "Salvataggio…", "Modifiche non salvate", "Salvato", "Le modifiche sono conservate. Riprova a salvare.", "È stata salvata un’altra revisione. Controllala prima di sostituire le modifiche.", "Controlla altra revisione", "Usa questa revisione come base", "Modello non disponibile", "Modello · creato da {name}", "Di {author} · {version} · {sharing}", "Salvare prima di uscire? Le modifiche restano nella bozza aperta di questo account fino alla chiusura dell’app.", "Esci conservando le modifiche", "Esclusi", "Descrizione", "Privato"], "it"),
    "pt": copy(["Modelo de Bot", "Dar uma cópia", "Criar um modelo para outros fazerem o seu", "Rever modelo", "O que recebem", "Instruções", "Primeira tarefa", "Versão", "Notas da versão", "Destinatário da cópia", "Rascunho privado", "Partilhado", "A guardar…", "Alterações por guardar", "Guardado", "As alterações foram mantidas. Tenta guardar novamente.", "Foi guardada outra revisão. Revê-a antes de substituir as alterações.", "Rever outra revisão", "Usar esta revisão como base", "Modelo indisponível", "Modelo · criado a partir de {name}", "Por {author} · {version} · {sharing}", "Guardar antes de sair? As alterações ficam no rascunho aberto desta conta até fechar a aplicação.", "Sair mantendo as alterações", "Excluído", "Descrição", "Privado"], "pt"),
    "ca": copy(["Plantilla de Bot", "Dona una còpia", "Crea una plantilla perquè altres en facin el seu", "Revisa la plantilla", "Què reben", "Instruccions", "Primera tasca", "Versió", "Notes de versió", "Destinatari de la còpia", "Esborrany privat", "Compartit", "Desant…", "Canvis sense desar", "Desat", "Els canvis es conserven. Torna a provar de desar.", "S’ha desat una altra revisió. Revisa-la abans de substituir els canvis.", "Revisa l’altra revisió", "Utilitza aquesta revisió com a base", "Plantilla no disponible", "Plantilla · creada a partir de {name}", "Per {author} · {version} · {sharing}", "Vols desar abans de sortir? Els canvis romanen a l’esborrany obert d’aquest compte fins que es tanqui l’aplicació.", "Surt conservant els canvis", "Exclòs", "Descripció", "Privat"], "ca"),
    "ja": copy(["Botテンプレート", "コピーを渡す", "他の人が自分用に始められるテンプレートを作成", "テンプレートを確認", "含まれる内容", "指示", "最初のタスク", "リリースバージョン", "リリースノート", "コピーの受信者", "非公開の下書き", "共有済み", "保存中…", "未保存の変更", "保存済み", "編集内容は保持されています。保存を再試行してください。", "別のリビジョンが保存されました。編集を置き換える前に確認してください。", "別のリビジョンを確認", "このリビジョンを保存の基準にする", "テンプレートを利用できません", "テンプレート · {name}から作成", "作成者 {author} · {version} · {sharing}", "移動前に保存しますか？編集はアプリを閉じるまで、このアカウントの開いている下書きに保持されます。", "編集を保持して移動", "除外", "説明", "非公開"], "ja"),
    "ru": copy(["Шаблон бота", "Дать копию", "Создать шаблон, из которого другие сделают своего", "Проверить шаблон", "Что получат", "Инструкции", "Первая задача", "Версия выпуска", "Примечания к выпуску", "Получатель копии", "Личный черновик", "Опубликовано", "Сохранение…", "Несохранённые изменения", "Сохранено", "Изменения сохранены локально. Повторите сохранение.", "Сохранена другая редакция. Проверьте её перед заменой изменений.", "Проверить другую редакцию", "Использовать эту редакцию как основу", "Шаблон недоступен", "Шаблон · создан из {name}", "Автор {author} · {version} · {sharing}", "Сохранить перед выходом? Изменения останутся в открытом черновике этого аккаунта до закрытия приложения.", "Выйти с сохранением правок в черновике", "Исключено", "Описание", "Личный"], "ru"),
    "pl": copy(["Szablon bota", "Przekaż kopię", "Utwórz szablon, z którego inni zrobią własnego", "Sprawdź szablon", "Co otrzymają", "Instrukcje", "Pierwsze zadanie", "Wersja wydania", "Informacje o wydaniu", "Odbiorca kopii", "Prywatny szkic", "Udostępniony", "Zapisywanie…", "Niezapisane zmiany", "Zapisano", "Zmiany są zachowane. Spróbuj zapisać ponownie.", "Zapisano inną rewizję. Sprawdź ją przed zastąpieniem zmian.", "Sprawdź inną rewizję", "Użyj tej rewizji jako podstawy", "Szablon niedostępny", "Szablon · utworzony z {name}", "Autor {author} · {version} · {sharing}", "Zapisać przed wyjściem? Zmiany pozostaną w otwartym szkicu tego konta do zamknięcia aplikacji.", "Wyjdź z zachowaniem zmian", "Pominięto", "Opis", "Prywatny"], "pl"),
    "zh-Hans": copy(["Bot模板", "提供副本", "创建他人可用来创建自己 Bot 的模板", "审核模板", "包含的内容", "指令", "首个任务", "发布版本", "发布说明", "副本接收者", "私有草稿", "已共享", "正在保存…", "未保存的更改", "已保存", "编辑内容已保留。请重试保存。", "已保存其他修订版。请先审核再覆盖更改。", "审核其他修订版", "将此修订版用作保存基准", "模板不可用", "模板 · 基于{name}创建", "作者 {author} · {version} · {sharing}", "离开前保存吗？编辑内容会保留在此账户打开的草稿中，直到关闭应用。", "保留编辑并离开", "已排除", "描述", "私有"], "zh-Hans"),
    "zh-Hant": copy(["Bot範本", "提供副本", "建立他人可用來建立自己 Bot 的範本", "審核範本", "包含的內容", "指令", "首個任務", "發佈版本", "發佈說明", "副本接收者", "私人草稿", "已分享", "正在儲存…", "未儲存的變更", "已儲存", "編輯內容已保留。請重試儲存。", "已儲存其他修訂版。請先審核再覆寫變更。", "審核其他修訂版", "將此修訂版用作儲存基準", "範本無法使用", "範本 · 基於{name}建立", "作者 {author} · {version} · {sharing}", "離開前儲存嗎？編輯內容會保留在此帳戶開啟的草稿中，直到關閉應用程式。", "保留編輯並離開", "已排除", "描述", "私人"], "zh-Hant"),
};
