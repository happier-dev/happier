//! The one display-choice decision; callers supply the current native inventory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayCandidate {
    pub storage_key: String,
    pub built_in: Option<bool>,
    pub primary: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DisplayChoice {
    pub index: usize,
    pub source: &'static str,
    pub fell_back: bool,
}
pub(crate) fn choose_display(mode: &str, displays: &[DisplayCandidate], main: Option<&str>) -> Option<DisplayChoice> {
    let automatic = || displays.iter().position(|d| d.built_in == Some(true))
        .map(|index| (index, "built_in"))
        .or_else(|| displays.iter().position(|d| d.primary).map(|index| (index, "primary")))
        .or_else(|| (!displays.is_empty()).then_some((0, "primary")));
    let requested = match mode {
        "automatic" => automatic(),
        "built_in" => displays.iter().position(|d| d.built_in == Some(true)).map(|index| (index, "built_in")),
        "main" => main.and_then(|key| displays.iter().position(|d| d.storage_key == key)).map(|index| (index, "main")),
        _ => mode.strip_prefix("named:").and_then(|key| displays.iter().position(|d| d.storage_key == key)).map(|index| (index, "named")),
    };
    let fell_back = requested.is_none() && mode != "automatic";
    requested.or_else(automatic).map(|(index, source)| DisplayChoice { index, source, fell_back })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn inventory() -> Vec<DisplayCandidate> {
        [("built-in", Some(true), false), ("primary", Some(false), true), ("studio", Some(false), false), ("projector", None, false)]
            .into_iter().map(|(key,built_in,primary)| DisplayCandidate { storage_key:key.into(), built_in, primary }).collect()
    }
    #[test]
    fn unplugged_named_display_falls_back_to_automatic_and_reports_fell_back() {
        let mut displays = inventory();
        let choice = "named:studio";
        assert_eq!(choose_display(choice,&displays,None), Some(DisplayChoice {index:2,source:"named",fell_back:false}));
        displays.remove(2);
        assert_eq!(choose_display(choice,&displays,None), Some(DisplayChoice {index:0,source:"built_in",fell_back:true}));
        displays.remove(0); // closed lid removes the built-in display from the connected inventory
        assert_eq!(choose_display(choice,&displays,None), Some(DisplayChoice {index:0,source:"primary",fell_back:true}));
        displays.push(DisplayCandidate {storage_key:"studio".into(),built_in:Some(false),primary:false});
        assert_eq!(choose_display(choice,&displays,None), Some(DisplayChoice {index:2,source:"named",fell_back:false}));
    }
    #[test]
    fn automatic_main_and_unknown_builtin_use_one_selection_owner() {
        let mut displays = inventory();
        assert_eq!(choose_display("automatic",&displays,None).unwrap().index,0);
        assert_eq!(choose_display("main",&displays,Some("studio")).unwrap().index,2);
        assert!(choose_display("main",&displays,Some("unplugged")).unwrap().fell_back);
        displays[0].built_in=None;
        assert_eq!(choose_display("automatic",&displays,None).unwrap().index,1);
        assert!(choose_display("built_in",&displays,None).unwrap().fell_back);
        assert_eq!(choose_display("automatic",&[],None),None);
    }
}
